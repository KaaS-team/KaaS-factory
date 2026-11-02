import { expect, test } from "bun:test";
import { buildSummary } from "../src/summary/plan-vs-reality";
import type { SummaryInput } from "../src/summary/types";

function fixture(over: Partial<SummaryInput["actual"]> = {}, plan: Partial<SummaryInput["plan"]> = {}): SummaryInput {
  return {
    plan: {
      goal: "Add the summary",
      risk: "medium",
      files: ["src/a.ts", "tests/a.test.ts"],
      criteria: ["one", "two"],
      nonGoals: ["docs/**"],
      ...plan,
    },
    actual: {
      touched: ["src/a.ts", "tests/a.test.ts"],
      riskAtHead: "medium",
      criteria: [
        { text: "one", ok: true },
        { text: "two", ok: true },
      ],
      notProven: [],
      stages: { build: 1, verify: 1 },
      rejectRounds: 0,
      retries: 0,
      takeover: false,
      ...over,
    },
  };
}

test("one extra file, one rejection and one unproven criterion give three deviations in row order", () => {
  const s = buildSummary(
    fixture({
      touched: ["src/a.ts", "tests/a.test.ts", "src/extra.ts"],
      notProven: ["two"],
      stages: { build: 1, verify: 2 },
      rejectRounds: 1,
    }),
  );
  expect(s.deviations.length).toBe(3);
  expect(s.deviations[0]).toContain("criteria:");
  expect(s.deviations[1]).toContain("src/extra.ts");
  expect(s.deviations[2]).toContain("attempts:");
  expect(s.notProven).toEqual(["two"]);
});

test("no review and no qa give two not-recorded rows and no zero", () => {
  const s = buildSummary(fixture());
  const missing = s.planVsReality.filter((r) => r.status === "not-recorded");
  expect(missing.map((r) => r.row)).toEqual(["review", "qa"]);
  for (const r of missing) expect(r.actual).toBeNull();
  for (const r of s.planVsReality) {
    expect(r.actual).not.toBe("0");
    expect(r.actual).not.toBe(0 as unknown as string);
  }
});

test("risk above the plan is a deviation and risk below it is met", () => {
  const high = buildSummary(fixture({ riskAtHead: "high" }));
  expect(high.planVsReality.find((r) => r.row === "risk")?.status).toBe("deviation");
  const low = buildSummary(fixture({ riskAtHead: "low" }));
  expect(low.planVsReality.find((r) => r.row === "risk")?.status).toBe("met");
});

test("the same input twice gives equal objects", () => {
  const input = fixture({ notProven: ["one"] });
  expect(buildSummary(input)).toEqual(buildSummary(input));
});

test("without operator no row mentions a model or a dollar amount", () => {
  const s = buildSummary(
    fixture({ review: { found: 2, fixed: 1, dismissed: 1, open: 0 }, qa: { passed: 3, total: 3 } }),
  );
  expect("operator" in s).toBe(false);
  for (const r of s.planVsReality) {
    for (const text of [r.planned, r.actual ?? "", r.detail ?? ""]) {
      expect(text.toLowerCase().includes("model")).toBe(false);
      expect(text.includes("$")).toBe(false);
    }
  }
});

test("operator passes through untouched", () => {
  const operator = { cost: "x", model: "y" };
  expect(buildSummary({ ...fixture(), operator }).operator).toBe(operator);
});

test("an open review finding and a touched non-goal are deviations", () => {
  const s = buildSummary(
    fixture({
      touched: ["src/a.ts", "tests/a.test.ts", "docs/x.md"],
      review: { found: 1, fixed: 0, dismissed: 0, open: 1 },
    }),
  );
  expect(s.deviations.some((d) => d.startsWith("scope:"))).toBe(true);
  expect(s.deviations.some((d) => d.startsWith("review:"))).toBe(true);
});

test("oneLine golden", () => {
  expect(buildSummary(fixture()).oneLine).toBe("2 of 2 criteria met, no deviations");
  expect(buildSummary(fixture({ notProven: ["two"], rejectRounds: 1 })).oneLine).toBe(
    "1 of 2 criteria met, 2 deviations",
  );
});
