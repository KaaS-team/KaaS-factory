// The three tiers steer every stage: the plan edge of the bundled workflow and the merge both
// read the same STEERING table, and a mode set from the web beats the config.
import { expect, test } from "bun:test";
import { STEERING, tierToggles } from "../src/autonomy";
import { DEFAULT_CONFIG } from "../src/config";
import { evalExpr } from "../src/core/expr";
import { defaultWorkflow } from "../src/engine/workflows";
import { decideMerge } from "../src/merge-policy";

const planEdge = defaultWorkflow().steps.plan!.next[0]!;
const control = (mode?: string) => ({
  listIssuesByLabel: async () =>
    mode
      ? [
          {
            number: 1,
            title: "",
            body: "",
            labels: [],
            comments: [{ id: 1, author: "bot", body: `<!-- factory:mode ${mode} -->`, createdAt: "" }],
          },
        ]
      : [],
  currentLogin: async () => "bot",
  roleOf: async () => "admin" as const,
});

async function planGoesOn(mode: string | undefined, risk: string, config = DEFAULT_CONFIG) {
  const toggles = await tierToggles(control(mode) as never, "o/r", config.merge, risk);
  return evalExpr(planEdge.if!, {
    plan: { risk, autoApproveEligible: true },
    toggles: { autoApproveLowRisk: true, ...toggles },
    config,
  });
}

test("each tier steers triage, plan, build, PR, review and merge, and the web mode wins over config", async () => {
  expect(await planGoesOn("supervised", "low")).toBe(false);
  expect(await planGoesOn("semi", "low")).toBe(true);
  expect(await planGoesOn("semi", "medium")).toBe(false);
  expect(await planGoesOn("full", "high")).toBe(true);
  // No mode set keeps the repo's riskPolicy exactly as before.
  expect(await planGoesOn(undefined, "low")).toBe(true);
  const configFull = { ...DEFAULT_CONFIG, merge: { ...DEFAULT_CONFIG.merge, autonomy: "full" as const } };
  expect(await planGoesOn("supervised", "high", configFull)).toBe(false);
  expect(await planGoesOn(undefined, "high", configFull)).toBe(true);

  for (const s of Object.values(STEERING)) {
    expect([s.triage, s.build]).toEqual(["auto", "auto"]);
    expect(s.reviewers("high")).toBeGreaterThan(s.reviewers("low"));
  }
  expect([STEERING.supervised.pr, STEERING.semi.pr, STEERING.full.pr]).toEqual(["draft", "ready", "ready"]);
  const merge = (autonomy: "semi" | "full", risk: "low" | "high") =>
    decideMerge({
      readiness: {
        state: "open",
        isDraft: false,
        baseRefName: "main",
        headRefOid: "s",
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        hasUnresolvedReviewThreads: false,
        changesRequestedStale: false,
      },
      ci: {
        prNumber: 1,
        headSha: "s",
        status: "passed",
        checks: [{ name: "b", status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      risk,
      changedFiles: [],
      merge: { ...DEFAULT_CONFIG.merge, policy: "auto" },
      protectedPaths: [],
      expectedBaseRefName: "main",
      autonomy,
    });
  const reasons = (d: ReturnType<typeof merge>) => (d.outcome === "merge" ? [] : d.refusals.map((r) => r.reason));
  expect(reasons(merge("semi", "high"))).toContain("risk-not-low");
  expect(reasons(merge("full", "high"))).not.toContain("risk-not-low");
});
