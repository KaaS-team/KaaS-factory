// The plan critic's mechanical half (#89): checks a plan comment before it posts, so a plan
// build cannot carry out comes back to plan once, not to a human after build. The judgment half
// is factory-plan-critic, inside the plan skill (docs/decisions/plan-critic.md).

import { readStageArtifacts, stepStop, type PlanArtifact } from "../artifacts";
import type { FactoryConfig } from "../config";
import type { GhIssue } from "../github";
import { costFor } from "../pricing";
import { schemaProblem } from "../schemas";
import { bashAllowed, stageAllowRules } from "../stage-permissions";
import { runStage, stageJson, type WatchDeps } from "./common";
import type { PlannedTask } from "./import-plan";
import { pathProblem } from "./import-plan-step";
import { flooredPlan } from "./verify-facts";

const AC_LINE = /^\s*-\s*\*\*(AC-\d+):\*\*(.*)$/;

// Quoted text is an argument, never a separator, so a `node -e "a;b"` stays one part.
function parts(command: string): string[] {
  const masked = command.replace(/"[^"]*"|'[^']*'/g, (q) => "x".repeat(q.length));
  const out: string[] = [];
  let start = 0;
  for (const m of masked.matchAll(/&&|\|\||;|\|/g)) {
    out.push(command.slice(start, m.index).trim());
    start = m.index + m[0].length;
  }
  out.push(command.slice(start).trim());
  return out.filter(Boolean);
}

function section(comment: string, heading: string): string | undefined {
  const at = comment.search(new RegExp(`^###\\s+${heading}`, "mi"));
  if (at < 0) return undefined;
  const rest = comment.slice(at).split("\n").slice(1).join("\n");
  const end = rest.search(/^###?\s/m);
  return end < 0 ? rest : rest.slice(0, end);
}

// Must-fix items: an AC with no test or command after "checked by" (the bite check stated before
// build), and a named command build and verify may not run. A span with a space is a command;
// one without is a test or file name. A leading cd or VAR= is not on any allow-list, so it fails too.
export function planMustFix(comment: string, plan: Pick<PlanArtifact, "proof">, allow: readonly string[]): string[] {
  const found: string[] = [];
  const acs = comment.split("\n").flatMap((l) => {
    const m = AC_LINE.exec(l);
    return m ? [{ id: m[1]!, body: m[2]! }] : [];
  });
  if (!acs.length && section(comment, "Acceptance criteria") !== undefined)
    found.push("The plan lists no `- **AC-n:**` line under Acceptance criteria.");
  for (const { id, body } of acs) {
    const at = body.search(/checked by/i);
    const spans = at < 0 ? [] : [...body.slice(at).matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
    if (!spans.length) {
      found.push(`${id} names no test or command: end it with "checked by \`<test or command>\`".`);
      continue;
    }
    for (const span of spans.filter((s) => /\s/.test(s)))
      for (const part of parts(span))
        if (!bashAllowed(allow, part))
          found.push(`${id}: \`${part}\` is not a command build or verify may run, so it is refused there.`);
  }
  const tests = section(comment, "Tests to write first");
  if ((plan.proof ?? "test") === "test" && tests !== undefined && !/`[^`]+`/.test(tests))
    found.push("Tests to write first names no test: name each one in backticks.");
  return found;
}

// What build and verify may run between them: what an AC's command must match.
export function proofAllowRules(config: FactoryConfig, issue: number): string[] {
  return [
    ...new Set([
      ...stageAllowRules("build", issue, config.agentCommands),
      ...stageAllowRules("verify", issue, config.agentCommands),
    ]),
  ];
}

function sendBack(items: readonly string[], allow: readonly string[]): string {
  const rules = allow.filter((r) => r.startsWith("Bash(")).map((r) => r.slice(5, -1));
  return [
    "The runner's plan check found must-fix items. Fix each one, keep the AC ids and the revision number, and write plan-comment.md and plan.json again:",
    ...items.map((i) => `- ${i}`),
    "",
    `Commands build and verify may run: ${rules.join(", ")}. The repo gate is \`.factory/gates.sh\`.`,
  ].join("\n");
}

// What the model-free checks read: the plan.json fields, the comment (for which files are marked new), and the worktree.
export interface PlanCheck {
  readonly plan: object;
  readonly comment: string;
  readonly worktree: string;
  readonly config: FactoryConfig;
}

// Tokens one build run is assumed to use. An estimate for the budget check, not a meter.
const RUN_USAGE = { tokensIn: 150_000, tokensOut: 15_000 };

// The model an alias names through config.agents, else the build stage's agent (the model is undefined when none is set).
function runModel(alias: string | undefined, config: FactoryConfig): string | undefined {
  const build = config.stages.build ?? config.stages.default ?? "claude";
  return (alias && config.agents[alias]?.model) ?? config.agents[build]?.model;
}

// One build run per task, or one run when the plan has no tasks. Undefined when any run's model has no price.
export function estimateCost(plan: object, config: FactoryConfig): number | undefined {
  const fields = plan as Record<string, unknown>;
  const tasks = Array.isArray(fields.tasks) ? (fields.tasks as PlannedTask[]) : [];
  const aliases = tasks.length ? tasks.map((t) => t.model) : [fields.model as string | undefined];
  let total = 0;
  for (const alias of aliases) {
    const usd = costFor(runModel(alias, config), RUN_USAGE);
    if (usd === undefined) return undefined;
    total += usd;
  }
  return total;
}

// `(new)` is read from the comment's Files to touch lines, the form planFromIssue writes.
function fileProblemsFor({ plan, comment, worktree }: PlanCheck): string[] {
  const fields = plan as Record<string, unknown>;
  const filesBody = section(comment, "Files to touch") ?? "";
  const marked = new Set([...filesBody.matchAll(/^\s*-\s*`([^`]+)`\s*\(new\)/gm)].map((m) => m[1]!));
  // Only issue-written plans mark (new); a planner plan's files are checked for the outside-the-repo rule alone.
  const checkDisk = fields.source === "issue";
  const files = Array.isArray(fields.files) ? (fields.files as string[]) : [];
  return files.flatMap((p) => pathProblem(worktree, p, marked.has(p), checkDisk));
}

function taskProblems(plan: object): string[] {
  const fields = plan as Record<string, unknown>;
  const tasks = Array.isArray(fields.tasks) ? (fields.tasks as { id: string }[]) : [];
  if (!tasks.length) return [];
  const ids = new Set(tasks.map((t) => t.id));
  const criteria = Array.isArray(fields.criteria) ? (fields.criteria as { id: string; task?: string }[]) : [];
  return criteria.flatMap((c) =>
    c.task && ids.has(c.task) ? [] : [`${c.id} maps to ${c.task || "no task"}, which is not a task in Change.`],
  );
}

function budgetProblems(input: PlanCheck): string[] {
  const estimate = estimateCost(input.plan, input.config);
  const budget = input.config.maxBudgetUsd.build;
  if (estimate === undefined || estimate <= budget) return [];
  return [`The estimated build cost is $${estimate.toFixed(2)}, over the $${budget.toFixed(2)} maxBudgetUsd.build.`];
}

// Model-free checks, run before any critic model. A schema failure stops here, because the other
// checks read fields the schema guarantees.
export function deterministicCritique(input: PlanCheck): string[] {
  const schema = schemaProblem("plan", input.plan as Record<string, unknown>);
  if (schema) return [`The plan JSON fails its schema: ${schema}.`];
  return [...fileProblemsFor(input), ...taskProblems(input.plan), ...budgetProblems(input)];
}

// The deterministic problems, and the model critic only when they find nothing. The runner passes no
// model critic today; Part 2 supplies one.
export function critiquePlan(input: PlanCheck, modelCritic?: (input: PlanCheck) => string[]): string[] {
  const problems = deterministicCritique(input);
  if (problems.length || !modelCritic) return problems;
  return modelCritic(input);
}

export interface CheckedPlan {
  readonly result: Awaited<ReturnType<typeof runStage>>;
  readonly comment?: string;
  readonly question?: string;
  readonly parsed: { readonly json?: PlanArtifact; readonly problem?: string };
}

async function attempt(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  worktree: string,
  opts: Parameters<typeof runStage>[5],
): Promise<CheckedPlan & { mustFix: string[] }> {
  const result = await runStage(deps, config, issue, "plan", worktree, opts);
  const art = await readStageArtifacts(worktree, issue.number, "plan");
  const parsed = flooredPlan(stageJson<PlanArtifact>("plan", art.json), config);
  const json = parsed.json;
  const checkable = result.exitCode === 0 && json && !stepStop(json) && json.status !== "needs-info" && art.comment;
  const mustFix = checkable
    ? [
        ...planMustFix(art.comment!, json, proofAllowRules(config, issue.number)),
        ...critiquePlan({ plan: json, comment: art.comment!, worktree, config }),
      ]
    : [];
  return { result, comment: art.comment, question: art.question, parsed, mustFix };
}

// One plan run, and at most one revision on a fork of its session. What is still wrong after that
// posts with the plan and waits for a human, never auto-approved.
export async function checkedPlan(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  worktree: string,
  opts: Parameters<typeof runStage>[5] = {},
): Promise<CheckedPlan> {
  let run = await attempt(deps, config, issue, worktree, opts);
  if (!run.mustFix.length) return run;
  const sessionId = deps.state.lastSession(config.repo, issue.number, "plan")?.session_id;
  const failure = sendBack(run.mustFix, proofAllowRules(config, issue.number));
  run = await attempt(deps, config, issue, worktree, {
    ...opts,
    resume: { ...(sessionId ? { sessionId } : {}), failure },
  });
  if (!run.mustFix.length || !run.parsed.json) return run;
  const note = `\n\n### Plan check: still open\n\n${run.mustFix.map((i) => `- ${i}`).join("\n")}\n\nThis plan waits for \`/factory approve\` or \`/factory revise <what to change>\`.\n`;
  return {
    ...run,
    comment: `${run.comment!.trimEnd()}${note}`,
    parsed: { ...run.parsed, json: { ...run.parsed.json, autoApproveEligible: false } },
  };
}
