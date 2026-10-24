// v2.9.0: the dashboard's "Approve and merge" button reuses the same
// readiness gate and merge primitive as the automated policy, and a
// CHANGES_REQUESTED review superseded by new commits no longer blocks.

import { expect, test } from "bun:test";
import type { CiCheck, CiResult } from "../src/ci";
import type { MergeReadiness } from "../src/github";
import {
  attemptMerge,
  checkReadiness,
  decideMerge,
  decideOperatorMerge,
  renderOperatorAuditComment,
  type DecideMergeInput,
} from "../src/merge-policy";

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

function fakeMergePr() {
  const calls: { repo: string; prNumber: number; headSha: string }[] = [];
  return {
    calls,
    mergePr: async (repo: string, prNumber: number, headSha: string) => {
      calls.push({ repo, prNumber, headSha });
    },
  };
}

test("a CHANGES_REQUESTED review against a superseded commit no longer blocks", () => {
  const stale = checkReadiness(
    readiness({ reviewDecision: "CHANGES_REQUESTED", changesRequestedStale: true }),
    ci(),
    "main",
  );
  expect(stale.map((r) => r.reason)).not.toContain("reviews-required");

  const fresh = checkReadiness(
    readiness({ reviewDecision: "CHANGES_REQUESTED", changesRequestedStale: false }),
    ci(),
    "main",
  );
  expect(fresh.map((r) => r.reason)).toContain("reviews-required");
});

test("decideOperatorMerge merges a clean PR without any risk/path/size gate", () => {
  const decision = decideOperatorMerge(readiness(), ci());
  expect(decision.outcome).toBe("merge");
  if (decision.outcome === "merge") expect(decision.headSha).toBe("sha1");
});

test("decideOperatorMerge refuses on the same readiness problems as the auto policy", () => {
  const draft = decideOperatorMerge(readiness({ isDraft: true }), ci());
  expect(draft.outcome).toBe("refuse");
  if (draft.outcome === "refuse") expect(draft.refusals.map((r) => r.reason)).toContain("draft");

  const failedCi = decideOperatorMerge(readiness(), ci({ status: "failed" }));
  expect(failedCi.outcome).toBe("refuse");
  if (failedCi.outcome === "refuse") expect(failedCi.refusals.map((r) => r.reason)).toContain("ci-failed");
});

test("the operator audit comment always carries the head-sha marker, with wording distinct from the auto comment", () => {
  const merged = decideOperatorMerge(readiness(), ci());
  const comment = renderOperatorAuditComment(merged);
  expect(comment).toContain("<!-- factory:merge-policy:sha1 -->");
  expect(comment).toContain("operator");
  expect(comment).not.toContain("**auto**");
});

test("one merge function serves both the automated policy and the operator button", async () => {
  const github = fakeMergePr();

  const autoInput: DecideMergeInput = {
    readiness: readiness(),
    ci: ci(),
    risk: "low",
    changedFiles: [{ path: "docs/guide.md", additions: 1, deletions: 0 }],
    merge: { policy: "auto", autoPaths: ["docs/**"], maxFiles: 10, maxLines: 200 },
    protectedPaths: [],
    expectedBaseRefName: "main",
  };
  expect(await attemptMerge(github, "o/r", 1, decideMerge(autoInput))).toBe(true);

  const operatorDecision = decideOperatorMerge(readiness({ headRefOid: "sha2" }), ci({ headSha: "sha2" }));
  expect(await attemptMerge(github, "o/r", 2, operatorDecision)).toBe(true);

  expect(github.calls).toEqual([
    { repo: "o/r", prNumber: 1, headSha: "sha1" },
    { repo: "o/r", prNumber: 2, headSha: "sha2" },
  ]);
});
