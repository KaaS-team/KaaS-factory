// The PR body the runner opens: What changed from the final plan, diff and proof, then the pr stage's
// own text, Acceptance, the Receipt, and last the Factory run summary.

import type { FactoryConfig } from "../config";
import { isHumanComment, parseChatOps } from "../chatops";
import type { GhIssue } from "../github";
import type { ProofResult, ProofStatus } from "../proof";
import { renderRunSummary } from "../run-summary";
import type { RunCtx, WatchDeps } from "./common";

// The PR body's opening section, built by the runner from the final plan, the diff and the proof, so it
// says what this branch does even when the pr stage's own text drifts or forgets to (#90).
export function renderWhatChanged(goal: string, files: readonly string[], proof: ProofResult | undefined): string {
  const lines = ["## What changed", "", goal.trim(), ""];
  lines.push(files.length ? `- Files: ${files.map((f) => `\`${f}\``).join(", ")}` : "- Files: none in the diff");
  if (proof?.status === "bites" && proof.tests.length)
    lines.push(
      `- Fails without it: ${proof.tests.map((t) => `\`${t}\``).join(", ")}, red with ${proof.reverted.map((f) => `\`${f}\``).join(", ") || "the change"} reverted`,
    );
  else lines.push(`- Fails without it: no test shown (proof ${proof?.status ?? "did not run"})`);
  return lines.join("\n");
}

// What the PR body is built from, beyond the pr stage's own text. Each piece is already rendered.
export interface PrParts {
  readonly whatChanged?: string;
  readonly acceptance?: string;
  readonly receipt?: string;
  readonly proof?: ProofStatus;
}

// The PR body opens with What changed, then the pr stage's text, the Acceptance section, the signed
// Receipt, and last the "Factory run" summary unless config.prRunSummary is off.
export function prBody(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  body: string,
  ctx: RunCtx,
  parts: PrParts = {},
): string {
  if (parts.whatChanged) body = `${parts.whatChanged}\n\n${body}`;
  // The acceptance section carries no model or spend, so prRunSummary does not hide it; the receipt
  // drops both itself when prRunSummary is off.
  if (parts.acceptance) body = `${body}\n\n${parts.acceptance}`;
  if (parts.receipt) body = `${body}\n\n${parts.receipt}`;
  if (!config.prRunSummary) return body;
  const runs = deps.state.listStageRuns(config.repo, { issue: issue.number });
  const retries = issue.comments.filter((c) => isHumanComment(c) && parseChatOps(c.body).type === "retry").length;
  const proof = parts.proof;
  return `${body}\n\n${renderRunSummary(runs, { rejectRounds: ctx.rejectRound, retries, proof })}`;
}
