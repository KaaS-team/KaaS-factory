// The PR body the runner opens: What changed from the final plan, diff and proof, then the pr stage's
// own text and Acceptance. The receipt goes to a comment on the issue; the run table (models, spend) stays
// in the operator view, because the issue thread is read by customers.

import type { FactoryConfig } from "../config";
import type { ExecutionPort } from "../ports/execution";
import type { ProofResult } from "../proof";
import { missingReceipt, renderReceipt, writeRunReceipt, type RunReceiptOptions } from "../receipt";
import type { WatchDeps } from "./common";

const RUN_DETAILS_MARKER = "<!-- factory:run-details -->";
const NO_COMMENT_ID = "no-id";

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

// The run-details comment's text. It lands on the customer-visible issue thread, so the receipt in it
// never carries a model or spend, whatever prRunSummary says.
export function renderRunDetails(exec: ExecutionPort, o: Omit<RunReceiptOptions, "operatorDetail">): Promise<string> {
  return writeRunReceipt(exec, { ...o, operatorDetail: false }).then(renderReceipt, (err: Error) =>
    missingReceipt(err.message),
  );
}

// One run-details comment per issue, edited in place, so a retry after a failed PR open or a revise
// re-entry leaves no duplicate and no stale envelope.
export async function postRunDetails(
  deps: WatchDeps,
  config: FactoryConfig,
  issueNumber: number,
  body: string,
): Promise<void> {
  const key = `run-details:${config.repo}#${issueNumber}`;
  const text = `${body}\n\n${RUN_DETAILS_MARKER}`;
  const kept = deps.state.getSetting(key);
  // A tracker that returns no comment id cannot be edited, so it keeps its first receipt rather than gaining one per retry.
  if (kept === NO_COMMENT_ID) return;
  const id = Number(kept);
  // A comment someone deleted fails the edit; posting a fresh one beats failing every retry on the stale id.
  if (id) {
    try {
      return await deps.github.editComment(config.repo, id, text);
    } catch (err) {
      // Only a deleted comment may fall through; an auth or rate-limit error would post a duplicate.
      if (!/404|not found/i.test(String((err as Error)?.message ?? err))) throw err;
    }
  }
  const posted = await deps.github.commentIssue(config.repo, issueNumber, text);
  deps.state.setSetting(key, posted === undefined ? NO_COMMENT_ID : String(posted));
}

// What the PR body is built from, beyond the pr stage's own text. Each piece is already rendered.
export interface PrParts {
  readonly whatChanged?: string;
  readonly acceptance?: string;
  // The per-task table and the closing line naming an epic's children (see epic.ts).
  readonly tasks?: string;
  readonly closes?: string;
  // How the body names the issue holding the run-details comment (see issueRef); it then points there.
  readonly runDetails?: string;
}

// `#n` links on GitHub; a PR body must not carry it for another tracker, whose n is not a GitHub issue.
export function issueRef(config: Pick<FactoryConfig, "tracker">, issueNumber: number): string {
  return config.tracker.kind === "github" ? `#${issueNumber}` : `tracker issue ${issueNumber}`;
}

// The PR body opens with What changed, then the pr stage's text and the Acceptance section. The receipt
// envelope stays out, in the issue comment, so the body never carries an attestation blob.
export function prBody(body: string, parts: PrParts = {}): string {
  if (parts.tasks) body = `${parts.tasks}\n\n${body}`;
  if (parts.whatChanged) body = `${parts.whatChanged}\n\n${body}`;
  if (parts.acceptance) body = `${body}\n\n${parts.acceptance}`;
  if (parts.closes) body = `${body}\n\n${parts.closes}`;
  if (parts.runDetails) body = `${body}\n\nThe receipt is in the run-details comment on ${parts.runDetails}.`;
  return body;
}
