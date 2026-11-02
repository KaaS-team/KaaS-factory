import { describe, expect, test } from "bun:test";
import { PRIORITY_RULES } from "../src/orchestrate/config";
import { groomNeed, planRefill, rankOf, rankReady, type PickIssue } from "../src/orchestrate/pick";

const issue = (number: number, labels: string[] = [], body = ""): PickIssue => ({ number, labels, body });

function plannedBody(files: string[], risk: "low" | "medium" | "high" = "low"): string {
  const listed = files.map((f) => `- \`${f}\``).join("\n");
  const taskFiles = files.map((f) => `\`${f}\``).join(", ");
  return [
    "<!-- factory:planned v1 -->",
    "## Why",
    "goal",
    "",
    "## Change",
    "### T1: work",
    `Files: ${taskFiles}`,
    "Model: haiku",
    "1. step",
    "",
    "## Tests",
    "- `tests/x.test.ts`: x",
    "",
    "## Mutation",
    "none: none",
    "",
    "## Acceptance",
    "- AC-1: ok: checked by `tests/x.test.ts` (T1)",
    "",
    "## Files",
    listed,
    "",
    `## Risk: ${risk}`,
    "## Model: sonnet",
  ].join("\n");
}

describe("rankReady", () => {
  test("priority first", () => {
    const p2_3 = issue(3, ["priority:P2"]);
    const p0_90 = issue(90, ["priority:P0"]);
    expect(rankReady([p2_3, p0_90], PRIORITY_RULES).map((i) => i.number)).toEqual([90, 3]);
  });

  test("number only", () => {
    const a = issue(9);
    const b = issue(2);
    const c = issue(5);
    expect(rankReady([a, b, c], ["number"]).map((i) => i.number)).toEqual([2, 5, 9]);
  });
});

describe("planRefill", () => {
  const order = ["cursor-cloud", "local"] as const;

  test("disjoint", () => {
    const i1 = issue(1);
    const i2 = issue(2);
    const i3 = issue(3);
    const filesOf = (i: PickIssue) =>
      i.number === 1 || i.number === 2 ? ["src/a.ts"] : i.number === 3 ? ["src/b.ts"] : [];
    const plan = planRefill({
      ranked: [i1, i2, i3],
      order: [...order],
      max: { "cursor-cloud": 4 },
      active: { "cursor-cloud": 0 },
      localFree: 2,
      filesOf,
      held: [],
      spendBlocked: false,
    });
    expect(plan.assign.map((a) => a.issue.number)).toEqual([1, 3]);
    expect(plan.waiting.map((i) => i.number)).toEqual([2]);
  });

  test("slots", () => {
    const cloud = issue(10, [], plannedBody(["src/cloud.ts"]));
    const localA = issue(11, [], plannedBody(["src/la.ts"]));
    const localB = issue(12, [], plannedBody(["src/lb.ts"]));
    const plan = planRefill({
      ranked: [cloud, localA, localB],
      order: [...order],
      max: { "cursor-cloud": 4 },
      active: { "cursor-cloud": 3 },
      localFree: 2,
      filesOf: (i) =>
        i.body.includes("cloud.ts") ? ["src/cloud.ts"] : i.body.includes("la.ts") ? ["src/la.ts"] : ["src/lb.ts"],
      held: [],
      spendBlocked: false,
    });
    const cloudAssign = plan.assign.filter((a) => a.provider === "cursor-cloud");
    expect(cloudAssign.length).toEqual(1);
    expect(cloudAssign[0]?.issue.number).toEqual(10);
    expect(plan.assign.filter((a) => a.provider === "local").length).toEqual(2);
  });

  test("spend blocked", () => {
    const cloud = issue(1, [], plannedBody(["src/a.ts"]));
    const plan = planRefill({
      ranked: [cloud],
      order: [...order],
      max: { "cursor-cloud": 4 },
      active: { "cursor-cloud": 0 },
      localFree: 1,
      filesOf: () => ["src/a.ts"],
      held: [],
      spendBlocked: true,
    });
    expect(plan.assign.length).toEqual(1);
    expect(plan.assign[0]?.provider).toEqual("local");
  });

  test("unplanned stays local", () => {
    const bare = issue(4, [], "Deps: none\n\n## Why\nx\n");
    const plan = planRefill({
      ranked: [bare],
      order: [...order],
      max: { "cursor-cloud": 4 },
      active: { "cursor-cloud": 0 },
      localFree: 1,
      filesOf: () => [],
      held: [],
      spendBlocked: false,
    });
    expect(plan.assign.length).toEqual(1);
    expect(plan.assign[0]?.provider).toEqual("local");
  });
});

describe("groomNeed", () => {
  test("groom need", () => {
    expect(groomNeed({ readyDepth: 1, target: 4, perTick: 1, enabled: true, spendBlocked: false, queued: 5 })).toEqual(
      1,
    );
  });

  test("zero at target", () => {
    expect(groomNeed({ readyDepth: 4, target: 4, perTick: 3, enabled: true, spendBlocked: false, queued: 5 })).toEqual(
      0,
    );
  });

  test("disabled", () => {
    expect(groomNeed({ readyDepth: 0, target: 4, perTick: 1, enabled: false, spendBlocked: false, queued: 5 })).toEqual(
      0,
    );
  });
});

describe("rankOf", () => {
  test("ranked first then the rest by number", () => {
    const ranked = [issue(90), issue(3)];
    const cmp = rankOf(ranked);
    const rest = [issue(50), issue(90), issue(3), issue(1)].sort(cmp);
    expect(rest.map((i) => i.number)).toEqual([90, 3, 1, 50]);
  });
});
