// Agent versus human review agreement: recorded by mergeContext, summarized read-only.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../src/config";
import { mergeContext } from "../src/merge-autonomy";
import { agentVerdict, evidenceEntries, evidenceReport, humanVerdict } from "../src/merge-evidence";
import type { PrFacts } from "../src/pr-facts";
import { writeVerifyFacts } from "../src/pr-facts-collect";
import { FactoryState } from "../src/state";

const config = {
  repo: "o/r",
  base: "main",
  protectedPaths: ["src/auth/**", "infra/**"],
  packages: [],
  merge: { policy: "auto", autonomy: "full", maxFiles: 10, maxLines: 200 },
} as unknown as FactoryConfig;

const review = (blockers: number): PrFacts["review"] => ({
  builderModel: "a",
  reviewers: [{ model: "b", blockers, verdict: blockers ? "reject" : "pass" }],
});

test("agent and human verdicts read off the facts and the review decision", () => {
  expect(agentVerdict(review(0))).toBe("approve");
  expect(agentVerdict(review(2))).toBe("reject");
  expect(agentVerdict(null)).toBe(undefined);
  expect(humanVerdict("APPROVED")).toBe("approve");
  expect(humanVerdict("CHANGES_REQUESTED")).toBe("reject");
  expect(humanVerdict("REVIEW_REQUIRED")).toBe(undefined);
  expect(humanVerdict("")).toBe(undefined);
});

test("mergeContext records a fixture history and the report lists agreement, gates and thin evidence", async () => {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "merge-evidence-"));
  const state = new FactoryState(join(dir, "state.db"));
  const decisions: Record<number, "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED"> = {
    1: "APPROVED",
    2: "APPROVED",
    3: "CHANGES_REQUESTED",
    4: "REVIEW_REQUIRED",
  };
  const agentBlockers: Record<number, number> = { 1: 0, 2: 3, 3: 2, 4: 0 };
  const files: Record<number, string> = {
    1: "src/auth/login.ts",
    2: "src/auth/token.ts",
    3: "src/util.ts",
    4: "src/x.ts",
  };
  const github = {
    listIssuesByLabel: async () => [],
    currentLogin: async () => "bot",
    roleOf: async () => "admin",
    mergeReadiness: async (_repo: string, pr: number) => ({ reviewDecision: decisions[pr] }),
  };
  for (const pr of [1, 2, 3, 4, 1]) {
    await writeVerifyFacts(dir, pr, { review: review(agentBlockers[pr]!) } as never);
    const changed = [{ path: files[pr]!, additions: 1, deletions: 0 }];
    await mergeContext({ github: github as never, state }, config, dir, pr, changed, pr);
  }
  const entries = evidenceEntries(state, "o/r");
  expect(entries.map((e) => [e.pr, e.agent, e.human, e.protectedHits])).toEqual([
    [2, "reject", "approve", ["src/auth/**"]],
    [3, "reject", "reject", []],
    [1, "approve", "approve", ["src/auth/**"]],
  ]);
  expect(evidenceEntries(state, "other/repo")).toEqual([]);

  const report = evidenceReport(state, config);
  expect(report).toBe(
    [
      "o/r: agent versus human review, 2/3 agree",
      "  src/auth/**: 1/2 agree",
      "  infra/**: no reviewed PRs",
      "Readiness gaps:",
      "  - merge.smokeUrl is not set, so no post-merge watch",
      "  - merge.previewUrl is not set, so no UI preview",
      "  - thin review evidence: 3 of 10 human-reviewed PRs",
      "  - thin review evidence on src/auth/**: 2 of 10",
      "  - thin review evidence on infra/**: 0 of 10",
    ].join("\n"),
  );
  state.close();
});
