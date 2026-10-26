// The plan critic's mechanical half (#89): checks a plan comment before it posts, so a plan
// build cannot carry out comes back to plan once, not to a human after build. The judgment half
// is factory-plan-critic, inside the plan skill (docs/decisions/plan-critic.md).

import { readStageArtifacts, stepStop, type PlanArtifact } from "../artifacts";
import type { FactoryConfig } from "../config";
import type { GhIssue } from "../github";
import { bashAllowed, stageAllowRules } from "../stage-permissions";
import { runStage, stageJson, type WatchDeps } from "./common";
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
  const mustFix = checkable ? planMustFix(art.comment!, json, proofAllowRules(config, issue.number)) : [];
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
