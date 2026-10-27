// The PR body the runner opens: What changed from the final plan, diff and proof, then the pr stage's
// own text and Acceptance. The receipt goes to a comment on the issue; the run table (models, spend) stays
// in the operator view, because the issue thread is read by customers.

import type { ProofResult } from "../proof";

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
  // Set when the receipt goes to a comment on the issue; the body then points there.
  readonly runDetails?: boolean;
}

// The PR body opens with What changed, then the pr stage's text and the Acceptance section. The receipt
// envelope stays out, in the issue comment, so the body never carries an attestation blob. The pointer
// names no issue number: a non-GitHub tracker's number would read as a GitHub reference.
export function prBody(body: string, parts: PrParts = {}): string {
  if (parts.whatChanged) body = `${parts.whatChanged}\n\n${body}`;
  if (parts.acceptance) body = `${body}\n\n${parts.acceptance}`;
  if (parts.runDetails) body = `${body}\n\nThe receipt is in the run-details comment on the issue.`;
  return body;
}
