// Ported from owainlewis/machinist@3943516 risk_delivery/gate.py (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the refusal list also follows owainlewis/agent-skills@766699e skills/herdr-issue-coordinator/SKILL.md:209-226 (MIT, Copyright (c) 2026 Owain Lewis), reused as ten named refusal reasons rather than copied code; gate.py's hardcoded docs/README-only, 10-file, 200-line allow-list becomes repo config (merge.autoPaths/maxFiles/maxLines), since a blog post is often longer than 200 lines; validate/auto_eligible/run become checkReadiness/autoEligible/decideMerge+attemptMerge, split so a caller can render the "dry-run" audit comment without ever calling mergePr; the merge always runs `gh pr merge --squash --match-head-commit`, never `--admin`, so a branch-protection block is respected even under policy "auto"; the audit comment carries a `factory:merge-policy:<headSha>` marker instead of gate.py's own comment format, to match this codebase's data-marker convention (src/watch.ts). gate.py's file-mode and rename checks read `git diff --raw` modes and `--no-renames` paths from src/git.ts diffStat, and binary files are refused because numstat counts no lines for them.

import type { Risk } from "./artifacts";
import { touchesProtectedPath } from "./boundary";
import type { CiResult } from "./ci";
import type { MergeConfig } from "./config";
import type { GitHub, MergeReadiness } from "./github";
import { type CodeownersRule, codeownerRefusals } from "./profile-rules";

export interface ChangedFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  // The file's git mode after the change: 100644 a plain file, 000000 deleted; 100755, 120000
  // (symlink) and 160000 (submodule) change what runs or what the path points at.
  readonly mode?: string;
  // numstat counts no lines for a binary file, so maxLines cannot bound it.
  readonly binary?: boolean;
}

const PLAIN_MODES = new Set(["100644", "000000"]);

// The herdr-issue-coordinator merge-gate checklist (SKILL.md:209-226): ten
// conditions, any one of which blocks a merge regardless of the others.
export type MergeRefusalReason =
  | "not-open"
  | "draft"
  | "base-changed"
  | "head-changed"
  | "not-mergeable"
  | "ci-missing"
  | "ci-failed"
  | "reviews-required"
  | "unresolved-threads"
  | "risk-not-low"
  | "not-auto-eligible"
  | "policy-not-auto"
  | "codeowner-approval";

export interface MergeRefusal {
  readonly reason: MergeRefusalReason;
  readonly detail: string;
}

export type MergeDecision =
  | { readonly outcome: "merge"; readonly headSha: string }
  | { readonly outcome: "refuse"; readonly headSha: string; readonly refusals: readonly MergeRefusal[] }
  | {
      readonly outcome: "dry-run";
      readonly headSha: string;
      readonly eligible: boolean;
      readonly refusals: readonly MergeRefusal[];
    };

// Readiness- and CI-derived refusals: the PR's own state, independent of
// what changed. A head or base that moved since the caller's own snapshot
// blocks the merge rather than trusting a stale comparison.
export function checkReadiness(readiness: MergeReadiness, ci: CiResult, expectedBaseRefName: string): MergeRefusal[] {
  const refusals: MergeRefusal[] = [];
  if (readiness.state !== "open") refusals.push({ reason: "not-open", detail: `PR state is "${readiness.state}"` });
  if (readiness.isDraft) refusals.push({ reason: "draft", detail: "PR is still a draft" });
  if (readiness.baseRefName !== expectedBaseRefName) {
    refusals.push({
      reason: "base-changed",
      detail: `base is "${readiness.baseRefName}", expected "${expectedBaseRefName}"`,
    });
  }
  if (readiness.headRefOid !== ci.headSha) {
    refusals.push({
      reason: "head-changed",
      detail: `PR head is ${readiness.headRefOid}, CI result is for ${ci.headSha}`,
    });
  }
  if (readiness.mergeable !== "MERGEABLE") {
    refusals.push({ reason: "not-mergeable", detail: `mergeable state is "${readiness.mergeable}"` });
  }
  if (ci.checks.length === 0) {
    refusals.push({ reason: "ci-missing", detail: "no CI checks are registered on this commit" });
  } else if (ci.status !== "passed") {
    refusals.push({ reason: "ci-failed", detail: `CI status is "${ci.status}"` });
  }
  // A CHANGES_REQUESTED review whose commit the head has since moved past no
  // longer blocks (v2.9.0 item 3): the reviewer asked for changes on a commit
  // that isn't the one about to merge.
  if (
    readiness.reviewDecision === "REVIEW_REQUIRED" ||
    (readiness.reviewDecision === "CHANGES_REQUESTED" && !readiness.changesRequestedStale)
  ) {
    refusals.push({ reason: "reviews-required", detail: `review decision is "${readiness.reviewDecision}"` });
  }
  if (readiness.hasUnresolvedReviewThreads) {
    refusals.push({ reason: "unresolved-threads", detail: "one or more review threads are unresolved" });
  }
  return refusals;
}

// The size/shape gate: even a fully green, fully reviewed PR only qualifies
// for auto-merge if the plan called it low risk and every changed file is
// small, few, and inside merge.autoPaths and outside protectedPaths. A file
// under protectedPaths is never eligible, whatever autoPaths says.
export function autoEligible(
  risk: Risk,
  changedFiles: readonly ChangedFile[],
  merge: Pick<MergeConfig, "autoPaths" | "maxFiles" | "maxLines">,
  protectedPaths: readonly string[],
): MergeRefusal[] {
  const refusals: MergeRefusal[] = [];
  if (risk !== "low") {
    refusals.push({ reason: "risk-not-low", detail: `plan risk is "${risk}", auto-merge requires "low"` });
  }
  const paths = changedFiles.map((f) => f.path);
  const protectedHits = touchesProtectedPath(paths, protectedPaths);
  if (protectedHits.length > 0) {
    refusals.push({ reason: "not-auto-eligible", detail: `protected path(s): ${protectedHits.join(", ")}` });
  }
  const globs = merge.autoPaths.map((pattern) => new Bun.Glob(pattern));
  const outside = paths.filter((path) => !globs.some((g) => g.match(path)));
  if (outside.length > 0) {
    refusals.push({ reason: "not-auto-eligible", detail: `outside merge.autoPaths: ${outside.join(", ")}` });
  }
  if (changedFiles.length > merge.maxFiles) {
    refusals.push({
      reason: "not-auto-eligible",
      detail: `${changedFiles.length} files changed, over merge.maxFiles (${merge.maxFiles})`,
    });
  }
  const oddModes = changedFiles.filter((f) => f.mode !== undefined && !PLAIN_MODES.has(f.mode));
  if (oddModes.length > 0) {
    refusals.push({
      reason: "not-auto-eligible",
      detail: `not a plain file (mode): ${oddModes.map((f) => `${f.path} (${f.mode})`).join(", ")}`,
    });
  }
  const binaries = changedFiles.filter((f) => f.binary);
  if (binaries.length > 0) {
    refusals.push({
      reason: "not-auto-eligible",
      detail: `binary, so its size is unknown: ${binaries.map((f) => f.path).join(", ")}`,
    });
  }
  const totalLines = changedFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (totalLines > merge.maxLines) {
    refusals.push({
      reason: "not-auto-eligible",
      detail: `${totalLines} lines changed, over merge.maxLines (${merge.maxLines})`,
    });
  }
  return refusals;
}

export interface DecideMergeInput {
  readonly readiness: MergeReadiness;
  readonly ci: CiResult;
  readonly risk: Risk;
  readonly changedFiles: readonly ChangedFile[];
  readonly merge: MergeConfig;
  readonly protectedPaths: readonly string[];
  readonly expectedBaseRefName: string;
  // Set when the profile asks a code owner to approve each touched file (src/profile-rules.ts).
  readonly codeowners?: { readonly rules: readonly CodeownersRule[]; readonly approvedBy: readonly string[] };
}

// Authority is explicit only (herdr SKILL.md:18-23): "merge" is returned only
// when policy is exactly "auto" and every readiness and eligibility check
// holds. "off" and any unrecognized policy always refuse, never merge —
// there is no default-allow path.
export function decideMerge(input: DecideMergeInput): MergeDecision {
  const headSha = input.readiness.headRefOid;
  const readinessRefusals = checkReadiness(input.readiness, input.ci, input.expectedBaseRefName);
  const eligibilityRefusals = autoEligible(input.risk, input.changedFiles, input.merge, input.protectedPaths);
  const owners = input.codeowners;
  const ownerRefusals = owners ? codeownerRefusals(owners.rules, input.changedFiles, owners.approvedBy) : [];
  const refusals = [...readinessRefusals, ...eligibilityRefusals, ...ownerRefusals];

  if (input.merge.policy === "dry-run") {
    return { outcome: "dry-run", headSha, eligible: refusals.length === 0, refusals };
  }
  if (input.merge.policy !== "auto") {
    return {
      outcome: "refuse",
      headSha,
      refusals: [{ reason: "policy-not-auto", detail: `merge.policy is "${input.merge.policy}"` }],
    };
  }
  if (refusals.length > 0) return { outcome: "refuse", headSha, refusals };
  return { outcome: "merge", headSha };
}

// Never called for a "refuse" or "dry-run" decision: this is the only path
// in this module that can reach GitHub.mergePr, and it only reaches it for
// outcome "merge". A retried call against an already-merged PR re-derives
// "refuse" (not-open) from a fresh readiness read upstream, so this never
// double-merges.
export async function attemptMerge(
  github: Pick<GitHub, "mergePr">,
  repo: string,
  prNumber: number,
  decision: MergeDecision,
): Promise<boolean> {
  if (decision.outcome !== "merge") return false;
  await github.mergePr(repo, prNumber, decision.headSha);
  return true;
}

export function mergePolicyMarker(headSha: string): string {
  return `<!-- factory:merge-policy:${headSha} -->`;
}

// The dashboard's "Approve and merge" button (v2.9.0 item 1): a human is the
// authority here, not repo config, so this skips autoEligible's risk/path/size
// gates entirely (herdr SKILL.md:18-23, "authority is explicit only": a
// human click is a different authority source than the auto-policy). It
// reuses checkReadiness with the PR's own baseRefName as the "expected" one,
// since an operator merge has no earlier plan snapshot to compare against;
// it is evaluated fresh, at click time. Readiness refusals (draft, CI,
// unresolved threads, ...) still apply: a human can approve, but the PR
// itself must still be mergeable.
export function decideOperatorMerge(readiness: MergeReadiness, ci: CiResult): MergeDecision {
  const headSha = readiness.headRefOid;
  const refusals = checkReadiness(readiness, ci, readiness.baseRefName);
  if (refusals.length > 0) return { outcome: "refuse", headSha, refusals };
  return { outcome: "merge", headSha };
}

// A separate function from renderAuditComment, so the ported test's exact
// "auto"/"dry-run" wording assertions never have to account for a third,
// operator-triggered source.
export function renderOperatorAuditComment(decision: MergeDecision): string {
  const marker = mergePolicyMarker(decision.headSha);
  if (decision.outcome === "merge") {
    return `${marker}\nMerge policy: **operator**, approved and merged \`${decision.headSha.slice(0, 7)}\` from the dashboard.`;
  }
  const lines = decision.refusals.map((r) => `- **${r.reason}**: ${r.detail}`);
  return [marker, "Merge policy: **operator**, blocked.", ...(lines.length ? ["", "Refusals:", ...lines] : [])].join(
    "\n",
  );
}

// The comment posted to the PR either way: what was decided, and why, so a
// human reviewing a "dry-run" or "refuse" outcome sees every reason at once.
export function renderAuditComment(decision: MergeDecision): string {
  const marker = mergePolicyMarker(decision.headSha);
  if (decision.outcome === "merge") {
    return `${marker}\nMerge policy: **auto** — all gates passed, merging \`${decision.headSha.slice(0, 7)}\`.`;
  }
  const label = decision.outcome === "dry-run" ? "dry-run" : "auto";
  const verdict =
    decision.outcome === "dry-run"
      ? decision.eligible
        ? 'would auto-merge once merge.policy is "auto"'
        : "would NOT auto-merge"
      : "blocked";
  const lines = decision.refusals.map((r) => `- **${r.reason}**: ${r.detail}`);
  return [
    marker,
    `Merge policy: **${label}** — ${verdict}.`,
    ...(lines.length ? ["", "Refusals:", ...lines] : []),
  ].join("\n");
}
