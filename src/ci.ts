// Ported from owainlewis/machinist@3943516 agent.py:439-459,487-592 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: closingIssuesReferences is matched by issue number, since GhPr only carries numbers, not URLs; the post-CI comments/reviews/review_comments collection and its Codex pending-reviewer wait (pending_reviewers) are not ported, since this pipeline has no Codex review bot integration (plan v2.8.0 lists only validatePr and waitForCi); the head-move check upstream ran against paginated review comments, but here it compares each poll's headRefOid against the first poll's, since there is no separate feedback-collection phase to re-check against; state, headRefOid, closingIssuesReferences and statusCheckRollup come from one shared GitHub.prStatus call instead of two separate `gh pr view` field sets; state is lowercased to match this codebase's "open"/"closed" convention (tests/harness.ts).
// Confirms a reported PR actually closes the issue it claims to (validatePr),
// then waits for its checks to settle (waitForCi) before merge-policy looks
// at it. Both take a GitHub-shaped dependency so tests never touch `gh`.

import type { GitHub, PrStatus } from "./github";

export class PrValidationError extends Error {}

export async function validatePr(
  github: Pick<GitHub, "prStatus">,
  repo: string,
  issueNumber: number,
  prNumber: number,
): Promise<void> {
  const pr = await github.prStatus(repo, prNumber);
  if (pr.state !== "open") throw new PrValidationError("the returned PR is not open");
  if (!pr.closingIssuesReferences.some((ref) => ref.number === issueNumber)) {
    throw new PrValidationError("the returned PR does not close the requested issue");
  }
}

export type CiStatus = "passed" | "failed" | "timed-out";

export interface CiCheck {
  readonly name?: string;
  readonly context?: string;
  readonly status?: string; // GraphQL CheckRun: "COMPLETED", "IN_PROGRESS", "QUEUED", ...
  readonly state?: string; // legacy commit status: "SUCCESS", "PENDING", "ERROR", "FAILURE"
  readonly conclusion?: string; // GraphQL CheckRun: "SUCCESS", "FAILURE", "NEUTRAL", "SKIPPED", ...
}

export interface CiResult {
  readonly prNumber: number;
  readonly headSha: string;
  readonly status: CiStatus;
  readonly checks: readonly CiCheck[];
}

export class CiWaitError extends Error {}

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const LEGACY_TERMINAL_STATES = new Set(["SUCCESS", "FAILURE", "ERROR"]);

function isFinished(check: CiCheck): boolean {
  return check.status !== undefined ? check.status === "COMPLETED" : LEGACY_TERMINAL_STATES.has(check.state ?? "");
}

function isPassing(check: CiCheck): boolean {
  return PASSING_CONCLUSIONS.has(check.conclusion ?? check.state ?? "");
}

export interface WaitForCiOptions {
  readonly timeoutSeconds?: number;
  readonly intervalSeconds?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

// An empty check list is pending (no checks registered yet is not the same as
// "passed"); SUCCESS, NEUTRAL and SKIPPED all count as passing; anything else
// on a finished check fails the run. Shared by waitForCi's loop and
// ciStatusNow's single snapshot below, so "what counts as passed" is defined
// in exactly one place.
function ciResultFrom(pr: Pick<PrStatus, "headRefOid" | "statusCheckRollup">, prNumber: number): CiResult {
  const checks = pr.statusCheckRollup;
  const finished = checks.length > 0 && checks.every(isFinished);
  const status: CiStatus = finished ? (checks.every(isPassing) ? "passed" : "failed") : "timed-out";
  return { prNumber, headSha: pr.headRefOid, status, checks };
}

// One snapshot, no waiting: a "not finished yet" check reads as "timed-out",
// the same label waitForCi gives a check that is still pending when its own
// deadline runs out. merge-policy's checkReadiness already treats any
// non-"passed" status as a refusal, so a still-running check correctly blocks
// a merge without this needing its own status value. Used by watch.ts's
// per-poll review check, which must never block a worker slot on CI the way
// waitForCi's loop below does (that would undo v2.7.0's continuous dispatch).
export async function ciStatusNow(github: Pick<GitHub, "prStatus">, repo: string, prNumber: number): Promise<CiResult> {
  const pr = await github.prStatus(repo, prNumber);
  return ciResultFrom(pr, prNumber);
}

// A PR that closes ends the wait immediately. A head that moves between polls
// also aborts the wait rather than silently re-polling the new commit's
// (probably still-pending) checks under the caller's old assumptions —
// merge-policy re-validates from scratch instead of resuming a stale wait.
export async function waitForCi(
  github: Pick<GitHub, "prStatus">,
  repo: string,
  prNumber: number,
  opts: WaitForCiOptions = {},
): Promise<CiResult> {
  const timeoutSeconds = opts.timeoutSeconds ?? 1200;
  const intervalSeconds = opts.intervalSeconds ?? 30;
  if (timeoutSeconds <= 0 || intervalSeconds <= 0) throw new CiWaitError("timeout and interval must be positive");
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutSeconds * 1000;
  let expectedHeadSha: string | undefined;

  for (;;) {
    const pr = await github.prStatus(repo, prNumber);
    if (pr.state !== "open") throw new CiWaitError("PR is no longer open; stopped waiting for CI");
    if (expectedHeadSha !== undefined && pr.headRefOid !== expectedHeadSha) {
      throw new CiWaitError("PR head moved while waiting for CI");
    }
    expectedHeadSha = pr.headRefOid;
    const result = ciResultFrom(pr, prNumber);
    const remainingMs = deadline - now();
    if (result.status !== "timed-out" || remainingMs <= 0) return result;
    await sleep(Math.min(intervalSeconds * 1000, remainingMs));
  }
}
