// The plan critic's mechanical half (#89): checks a plan comment before it posts, so a plan
// build cannot carry out comes back to plan once, not to a human after build. The judgment half
// is factory-plan-critic, inside the plan skill (docs/decisions/plan-critic.md).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStageArtifacts, stepStop, type PlanArtifact } from "../artifacts";
import type { FactoryConfig } from "../config";
import type { GhIssue } from "../github";
import { planCritiqueProblem, schemaProblem, type PlanCritique } from "../schemas";
import { bashAllowed, stageAllowRules } from "../stage-permissions";
import { runStage, stageJson, type WatchDeps } from "./common";
import { outside } from "./import-plan-step";
import { minionOutput } from "./minion";
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

// USD per plan item: the planner's own assumption, not calibrated on past runs (docs/decisions/plan-critic.md).
export const PLAN_COST = { base: 0.5, perFile: 0.4, perCriterion: 0.2 } as const;

export function estimateCost(plan: Pick<PlanArtifact, "files" | "criteria">): number {
  return PLAN_COST.base + PLAN_COST.perFile * plan.files.length + PLAN_COST.perCriterion * (plan.criteria?.length ?? 0);
}

export interface CritiqueCtx {
  readonly config: FactoryConfig;
  readonly issue: number;
  readonly worktree: string;
}

// Every problem the runner finds without a model: schema, planMustFix, files, AC mapping, estimate.
export function deterministicCritique(comment: string, plan: PlanArtifact, ctx: CritiqueCtx): string[] {
  const found: string[] = [];
  const schema = schemaProblem("plan", plan as unknown as Record<string, unknown>);
  if (schema) found.push(`plan.json: ${schema}.`);
  found.push(...planMustFix(comment, plan, proofAllowRules(ctx.config, ctx.issue)));
  for (const f of plan.files) {
    if (outside(ctx.worktree, f)) found.push(`\`${f}\` is outside the repo.`);
    else if (!existsSync(join(ctx.worktree, f)) && !existsSync(join(ctx.worktree, dirname(f))))
      found.push(`\`${f}\` does not exist and neither does its directory.`);
  }
  if (plan.criteria) {
    const inComment = new Set(comment.split("\n").flatMap((l) => AC_LINE.exec(l)?.[1] ?? []));
    const ids = new Set(plan.criteria.map((c) => c.id));
    for (const id of ids)
      if (!inComment.has(id)) found.push(`${id} is in plan.json but has no \`- **${id}:**\` line in the comment.`);
    for (const id of inComment) if (!ids.has(id)) found.push(`${id} is in the comment but not in plan.json criteria.`);
    const tasks = (plan as { tasks?: readonly { id?: unknown }[] }).tasks;
    if (tasks) {
      const taskIds = new Set(tasks.map((t) => t.id));
      for (const c of plan.criteria as readonly { id: string; task?: unknown }[])
        if (c.task !== undefined && !taskIds.has(c.task))
          found.push(`${c.id} names task ${String(c.task)}, which is not in plan.tasks.`);
    }
  }
  const cost = estimateCost(plan);
  const budget = ctx.config.maxBudgetUsd.build;
  if (cost > budget)
    found.push(`The estimate $${cost.toFixed(2)} is over the build budget $${budget.toFixed(2)}: split the plan.`);
  return found;
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
): Promise<CheckedPlan & { mustFix: string[]; checked: boolean }> {
  const result = await runStage(deps, config, issue, "plan", worktree, opts);
  const art = await readStageArtifacts(worktree, issue.number, "plan");
  const parsed = flooredPlan(stageJson<PlanArtifact>("plan", art.json), config);
  const json = parsed.json;
  const checkable = result.exitCode === 0 && json && !stepStop(json) && json.status !== "needs-info" && art.comment;
  const mustFix = checkable ? deterministicCritique(art.comment!, json, { config, issue: issue.number, worktree }) : [];
  return { result, comment: art.comment, question: art.question, parsed, mustFix, checked: Boolean(checkable) };
}

type Rubric = { readonly critique: PlanCritique } | { readonly note: string } | { readonly skipped: true };

function rubricPrompt(comment: string, plan: PlanArtifact): string {
  return [
    "You are the plan critic. Judge the plan below against the issue text in .factory/runs/issue-*/issue.json.",
    "Check five items: intent (it does what the issue asks), no scope creep, verify per task (each task has a check),",
    `risk set (the risk level cites the charter), estimate stated (the runner estimates $${estimateCost(plan).toFixed(2)}).`,
    'Reply with one JSON object and nothing else: {"verdict": "pass" | "revise", "reasons": [string]}.',
    'Use "revise" only for a real defect, and give one reason per defect.',
    "",
    comment,
  ].join("\n");
}

// One model call, after the deterministic pass is clean. It goes to the executor directly, not through
// runStage, so the plan artifacts the planner just wrote are not cleared.
async function rubricPass(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  worktree: string,
  run: CheckedPlan,
): Promise<Rubric> {
  const name = config.planCriticAgent ?? "sonnet";
  if (!config.agents[name])
    return config.planCriticAgent === undefined
      ? { skipped: true }
      : { note: `No agent named "${name}" in config.agents, so the rubric pass did not run.` };
  const result = await deps.executor.runStage({
    stage: "plan",
    issue: issue.number,
    cwd: worktree,
    maxBudgetUsd: config.maxBudgetUsd.plan,
    timeoutMinutes: config.stageTimeoutMinutes,
    maxToolCalls: config.maxToolCalls,
    agent: name,
    prompt: rubricPrompt(run.comment!, run.parsed.json!),
  });
  const reply = result.exitCode === 0 && !result.killedReason ? minionOutput("", result.finalMessage) : undefined;
  const problem = reply === undefined ? "the agent gave no JSON reply" : planCritiqueProblem(reply);
  if (problem) return { note: `The rubric reply was not usable (${problem}), so the plan is not auto-approved.` };
  return { critique: reply as PlanCritique };
}

function holdOpen(run: CheckedPlan, items: readonly string[]): CheckedPlan {
  if (!items.length || !run.parsed.json) return run;
  const note = `\n\n### Plan check: still open\n\n${items.map((i) => `- ${i}`).join("\n")}\n\nThis plan waits for \`/factory approve\` or \`/factory revise <what to change>\`.\n`;
  return {
    ...run,
    comment: `${run.comment!.trimEnd()}${note}`,
    parsed: { ...run.parsed, json: { ...run.parsed.json, autoApproveEligible: false } },
  };
}

// Two passes: deterministicCritique, then one rubric call only if it is clean. Either can send the plan
// back, once, on a fork of its session; the plan stage never runs a third time. What is still open posts
// with the plan and waits for a human, never auto-approved.
export async function checkedPlan(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  worktree: string,
  opts: Parameters<typeof runStage>[5] = {},
): Promise<CheckedPlan> {
  let run = await attempt(deps, config, issue, worktree, opts);
  let revised = false;
  const revise = async (items: readonly string[]) => {
    const sessionId = deps.state.lastSession(config.repo, issue.number, "plan")?.session_id;
    const failure = sendBack(items, proofAllowRules(config, issue.number));
    revised = true;
    run = await attempt(deps, config, issue, worktree, {
      ...opts,
      resume: { ...(sessionId ? { sessionId } : {}), failure },
    });
  };
  if (run.mustFix.length) await revise(run.mustFix);
  if (run.mustFix.length || !run.checked) return holdOpen(run, run.mustFix);
  const rubric = await rubricPass(deps, config, issue, worktree, run);
  if ("skipped" in rubric) return run;
  if ("note" in rubric) return holdOpen(run, [rubric.note]);
  if (rubric.critique.verdict === "pass") return run;
  const reasons = rubric.critique.reasons;
  deps.state.addPendingLesson(config.repo, issue.number, `Plan critic asked for a revision: ${reasons.join(" ")}`);
  if (revised)
    return holdOpen(
      run,
      reasons.map((r) => `Rubric (no revision round left): ${r}`),
    );
  await revise(reasons.map((r) => `Rubric: ${r}`));
  const unchecked = reasons.map((r) => `Rubric (not re-checked after the revision): ${r}`);
  return holdOpen(run, [...run.mustFix, ...(run.checked ? unchecked : [])]);
}
