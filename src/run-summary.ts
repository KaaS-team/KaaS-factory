// The PR body's "Factory run" section. Every line comes from stage_runs and
// the issue thread's own counts; nothing is inferred. Config prRunSummary
// turns it off for a repo whose PRs should not show models and spend.

import { OPERATOR_TAKEOVER } from "./executor";
import type { ProofStatus } from "./proof";
import type { StageRun } from "./state";

export interface RunSummaryCtx {
  // Verify rejections since the last /factory retry (deriveIssueState).
  readonly rejectRounds: number;
  // Trusted /factory retry comments on the issue.
  readonly retries: number;
  // The runner's revert check from proof.json, when it ran.
  readonly proof?: ProofStatus;
}

const PROOF_LINE: Record<ProofStatus, string> = {
  bites: "the new test fails without the change",
  "passes-without": "the new test also passes without the change",
  "no-tests": "the diff adds no test",
  skipped: "skipped: the plan's proof is check, so the named checks were re-run instead",
  unavailable: "unavailable: the repo has no test gate, so nothing showed the change works",
};

function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 120);
}

// A verify row reports its verdict: a clean exit with an uncertain verdict is not "ok".
function outcome(run: Pick<StageRun, "exit_code" | "killed_reason" | "verdict">): string {
  return run.killed_reason ?? (run.exit_code !== 0 ? `exit ${run.exit_code}` : (run.verdict ?? "ok"));
}

function succeeded(run: StageRun): boolean {
  return ["ok", "pass"].includes(outcome(run));
}

export function renderRunSummary(runs: readonly StageRun[], ctx: RunSummaryCtx): string {
  const rows = runs.filter((r) => (r.stage as string) !== "retro");
  const lines = [
    "## Factory run",
    "",
    "| Stage | Agent | Duration | Tool calls | Cost | Outcome |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.stage} | ${cell(r.model ? `${r.agent} (${r.model})` : r.agent)} | ${seconds(r.duration_ms)} | ${r.tool_calls} | ${r.cost_usd === null ? "not reported" : `$${r.cost_usd.toFixed(2)}`} | ${cell(outcome(r))} |`,
    ),
  ];
  const known = rows.filter((r) => r.cost_usd !== null).reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  const unknown = rows.filter((r) => r.cost_usd === null).length;
  const total = rows.reduce((sum, r) => sum + r.duration_ms, 0);
  if (ctx.proof) lines.push("", `Proof: ${PROOF_LINE[ctx.proof]}.`);
  lines.push(
    "",
    `${rows.length} stage runs, ${seconds(total)}, $${known.toFixed(2)}${unknown ? ` plus ${unknown} not reported` : ""}.`,
  );

  const stages = [...new Set(rows.map((r) => r.stage))];
  const firstTry = stages.filter((s) => {
    const of = rows.filter((r) => r.stage === s);
    return of.length === 1 && succeeded(of[0]!);
  });
  const well: string[] = [];
  if (firstTry.length) well.push(`${firstTry.join(", ")} passed on the first attempt`);
  if (firstTry.includes("verify") && ctx.rejectRounds === 0) well.push("verify approved on the first round");

  const help: string[] = [];
  for (const s of stages) {
    const n = rows.filter((r) => r.stage === s).length;
    if (n > 1) help.push(`${s} ran ${n} times`);
  }
  for (const r of rows) {
    if (r.killed_reason === OPERATOR_TAKEOVER) help.push(`${r.stage}: taken over by an operator`);
    else if (!succeeded(r)) help.push(`${r.stage}: ${cell(outcome(r))}`);
  }
  if (ctx.rejectRounds) help.push(`${ctx.rejectRounds} verify rejection(s)`);
  if (ctx.retries) help.push(`${ctx.retries} \`/factory retry\``);

  lines.push("", "**Went well**", "", ...(well.length ? well.map((w) => `- ${w}`) : ["- nothing on the first try"]));
  lines.push("", "**Needed help**", "", ...(help.length ? help.map((h) => `- ${h}`) : ["- nothing"]));
  return lines.join("\n");
}
