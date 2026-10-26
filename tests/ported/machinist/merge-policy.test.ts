// Ported from owainlewis/machinist@3943516 tests/test_gate.py (MIT, Copyright (c) 2026 Owain Lewis). Deviations: cases are adapted for this codebase's MergeReadiness/CiResult/MergeConfig shapes instead of gate.py's own dataclasses; the docs/README-only, 10-file, 200-line allow-list becomes autoPaths/maxFiles/maxLines from config (see src/merge-policy.ts's own header).

import { expect, test } from "bun:test";
import type { Risk } from "../../../src/artifacts";
import type { CiCheck, CiResult } from "../../../src/ci";
import type { MergeConfig } from "../../../src/config";
import type { MergeReadiness } from "../../../src/github";
import {
  attemptMerge,
  autoEligible,
  type ChangedFile,
  checkReadiness,
  decideMerge,
  type DecideMergeInput,
  renderAuditComment,
} from "../../../src/merge-policy";

const passingCheck: CiCheck = { name: "build", status: "COMPLETED", conclusion: "SUCCESS" };

function readiness(overrides: Partial<MergeReadiness> = {}): MergeReadiness {
  return {
    state: "open",
    isDraft: false,
    baseRefName: "main",
    headRefOid: "sha1",
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    hasUnresolvedReviewThreads: false,
    changesRequestedStale: false,
    ...overrides,
  };
}

function ci(overrides: Partial<CiResult> = {}): CiResult {
  return { prNumber: 1, headSha: "sha1", status: "passed", checks: [passingCheck], ...overrides };
}

function mergeConfig(overrides: Partial<MergeConfig> = {}): MergeConfig {
  return { policy: "auto", autoPaths: ["docs/**", "content/**"], maxFiles: 10, maxLines: 200, ...overrides };
}

function file(path: string, additions = 5, deletions = 1): ChangedFile {
  return { path, additions, deletions };
}

function input(overrides: Partial<DecideMergeInput> = {}): DecideMergeInput {
  return {
    readiness: readiness(),
    ci: ci(),
    risk: "low" as Risk,
    changedFiles: [file("docs/guide.md")],
    merge: mergeConfig(),
    protectedPaths: ["src/**"],
    expectedBaseRefName: "main",
    ...overrides,
  };
}

function fakeMergePr() {
  const calls: { repo: string; prNumber: number; headSha: string }[] = [];
  return {
    calls,
    mergePr: async (repo: string, prNumber: number, headSha: string) => {
      calls.push({ repo, prNumber, headSha });
    },
  };
}

test("only a small, low-risk docs change auto-merges", () => {
  const decision = decideMerge(input());
  expect(decision.outcome).toBe("merge");
  if (decision.outcome === "merge") expect(decision.headSha).toBe("sha1");
});

test("a head that moved, or an invalid (non-low) risk, blocks the merge", () => {
  const headMoved = decideMerge(input({ ci: ci({ headSha: "sha2" }) }));
  expect(headMoved.outcome).toBe("refuse");
  if (headMoved.outcome === "refuse") expect(headMoved.refusals.map((r) => r.reason)).toContain("head-changed");

  const highRisk = decideMerge(input({ risk: "high" }));
  expect(highRisk.outcome).toBe("refuse");
  if (highRisk.outcome === "refuse") expect(highRisk.refusals.map((r) => r.reason)).toContain("risk-not-low");
});

test("missing checks never calls merge", async () => {
  const decision = decideMerge(input({ ci: ci({ checks: [] }) }));
  expect(decision.outcome).toBe("refuse");
  if (decision.outcome === "refuse") expect(decision.refusals.map((r) => r.reason)).toContain("ci-missing");

  const github = fakeMergePr();
  const merged = await attemptMerge(github, "o/r", 1, decision);
  expect(merged).toBe(false);
  expect(github.calls).toEqual([]);
});

test("a success decision merges only the reviewed sha, with no bypass flag available to pass", async () => {
  const decision = decideMerge(input());
  const github = fakeMergePr();
  const merged = await attemptMerge(github, "o/r", 1, decision);
  expect(merged).toBe(true);
  expect(github.calls).toEqual([{ repo: "o/r", prNumber: 1, headSha: "sha1" }]);
});

test("failed CI, pending (timed-out) CI, missing checks, and a required review each block on their own", () => {
  const failed = decideMerge(input({ ci: ci({ status: "failed" }) }));
  expect(failed.outcome).toBe("refuse");
  if (failed.outcome === "refuse") expect(failed.refusals.map((r) => r.reason)).toContain("ci-failed");

  const pending = decideMerge(input({ ci: ci({ status: "timed-out" }) }));
  expect(pending.outcome).toBe("refuse");
  if (pending.outcome === "refuse") expect(pending.refusals.map((r) => r.reason)).toContain("ci-failed");

  const missing = decideMerge(input({ ci: ci({ checks: [] }) }));
  expect(missing.outcome).toBe("refuse");
  if (missing.outcome === "refuse") expect(missing.refusals.map((r) => r.reason)).toContain("ci-missing");

  const reviewRequired = decideMerge(input({ readiness: readiness({ reviewDecision: "REVIEW_REQUIRED" }) }));
  expect(reviewRequired.outcome).toBe("refuse");
  if (reviewRequired.outcome === "refuse")
    expect(reviewRequired.refusals.map((r) => r.reason)).toContain("reviews-required");
});

test("a draft PR, or one with merge conflicts, blocks even with every other gate green", () => {
  const draft = decideMerge(input({ readiness: readiness({ isDraft: true }) }));
  expect(draft.outcome).toBe("refuse");
  if (draft.outcome === "refuse") expect(draft.refusals.map((r) => r.reason)).toContain("draft");

  const conflicting = decideMerge(input({ readiness: readiness({ mergeable: "CONFLICTING" }) }));
  expect(conflicting.outcome).toBe("refuse");
  if (conflicting.outcome === "refuse") expect(conflicting.refusals.map((r) => r.reason)).toContain("not-mergeable");
});

test("a base branch that changed since the plan was made blocks the merge", () => {
  const decision = decideMerge(input({ readiness: readiness({ baseRefName: "develop" }) }));
  expect(decision.outcome).toBe("refuse");
  if (decision.outcome === "refuse") expect(decision.refusals.map((r) => r.reason)).toContain("base-changed");
});

test("unresolved review threads block, even with an approved review and green CI", () => {
  const decision = decideMerge(input({ readiness: readiness({ hasUnresolvedReviewThreads: true }) }));
  expect(decision.outcome).toBe("refuse");
  if (decision.outcome === "refuse") expect(decision.refusals.map((r) => r.reason)).toContain("unresolved-threads");
});

test("a successful merge is idempotent on retry: the second attempt refuses instead of merging again", async () => {
  const github = fakeMergePr();
  const first = decideMerge(input());
  expect(await attemptMerge(github, "o/r", 1, first)).toBe(true);

  // A retry re-reads readiness fresh; the PR is now merged, not open.
  const second = decideMerge(input({ readiness: readiness({ state: "merged" }) }));
  expect(second.outcome).toBe("refuse");
  if (second.outcome === "refuse") expect(second.refusals.map((r) => r.reason)).toContain("not-open");
  expect(await attemptMerge(github, "o/r", 1, second)).toBe(false);
  expect(github.calls.length).toBe(1);
});

test("medium risk, or a code change outside autoPaths, requires human approval instead of auto-merging", () => {
  const mediumRisk = decideMerge(input({ risk: "medium" }));
  expect(mediumRisk.outcome).toBe("refuse");
  if (mediumRisk.outcome === "refuse") expect(mediumRisk.refusals.map((r) => r.reason)).toContain("risk-not-low");

  const codeChange = decideMerge(input({ changedFiles: [file("app/routes/checkout.ts")] }));
  expect(codeChange.outcome).toBe("refuse");
  if (codeChange.outcome === "refuse") expect(codeChange.refusals.map((r) => r.reason)).toContain("not-auto-eligible");
});

test("a file under protectedPaths is never auto-eligible, even when it also matches autoPaths", () => {
  const refusals = autoEligible(
    "low",
    [file("src/secrets.ts")],
    { autoPaths: ["src/**"], maxFiles: 10, maxLines: 200 },
    ["src/secrets.ts"],
  );
  expect(refusals.map((r) => r.reason)).toContain("not-auto-eligible");
});

test("too many files or too many lines blocks auto-eligibility on its own", () => {
  const tooManyFiles = autoEligible(
    "low",
    [file("docs/a.md"), file("docs/b.md")],
    { autoPaths: ["docs/**"], maxFiles: 1, maxLines: 200 },
    [],
  );
  expect(tooManyFiles.map((r) => r.reason)).toContain("not-auto-eligible");

  const tooManyLines = autoEligible(
    "low",
    [file("docs/a.md", 500, 0)],
    { autoPaths: ["docs/**"], maxFiles: 10, maxLines: 200 },
    [],
  );
  expect(tooManyLines.map((r) => r.reason)).toContain("not-auto-eligible");
});

test("dry-run never merges, and reports eligibility without acting on it", async () => {
  const decision = decideMerge(input({ merge: mergeConfig({ policy: "dry-run" }) }));
  expect(decision.outcome).toBe("dry-run");
  if (decision.outcome === "dry-run") expect(decision.eligible).toBe(true);

  const github = fakeMergePr();
  expect(await attemptMerge(github, "o/r", 1, decision)).toBe(false);
  expect(github.calls).toEqual([]);
});

test("policy off always refuses, with no config path to a merge", () => {
  const decision = decideMerge(input({ merge: mergeConfig({ policy: "off" }) }));
  expect(decision.outcome).toBe("refuse");
  if (decision.outcome === "refuse") expect(decision.refusals.map((r) => r.reason)).toContain("policy-not-auto");
});

test("the audit comment always carries the head-sha marker", () => {
  const merged = decideMerge(input());
  expect(renderAuditComment(merged)).toContain("<!-- factory:merge-policy:sha1 -->");

  const refused = decideMerge(input({ risk: "high" }));
  const comment = renderAuditComment(refused);
  expect(comment).toContain("<!-- factory:merge-policy:sha1 -->");
  expect(comment).toContain("risk-not-low");
});

test("checkReadiness is the readiness half alone: eligibility problems never appear in its output", () => {
  const refusals = checkReadiness(readiness(), ci(), "main");
  expect(refusals).toEqual([]);
});

// Not in gate.py: the scaleup and enterprise profiles hold a merge for code owners (src/profile-rules.ts).
test("decideMerge refuses with codeowner-approval while a touched file's code owner has not approved", () => {
  const codeowners = { rules: [{ pattern: /^docs\//, owners: ["@docs-lead"] }], approvedBy: ["someone"] };
  const decision = decideMerge(input({ codeowners }));
  expect(decision.outcome).toBe("refuse");
  if (decision.outcome === "refuse") expect(decision.refusals.map((r) => r.reason)).toEqual(["codeowner-approval"]);
  expect(decideMerge(input({ codeowners: { ...codeowners, approvedBy: ["Docs-Lead"] } })).outcome).toBe("merge");
});
