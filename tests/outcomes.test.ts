import { describe, expect, test } from "bun:test";
import { type Outcome, type OutcomeState, outcomeReport } from "../src/outcomes";

const o = (state: OutcomeState, cost: number | null, extra: Partial<Outcome> = {}): Outcome => ({
  kind:
    state === "merged" || state === "closed" ? "pr" : state === "kept" || state === "dismissed" ? "issue" : "comment",
  workflow: "feature-to-pr",
  team: "web",
  at: "2026-10-10T00:00:00Z",
  state,
  cost_usd: cost,
  ...extra,
});

// One of each state, so every classification is counted on its own.
const history: Outcome[] = [
  o("merged", 2),
  o("closed", 3),
  o("kept", 1),
  o("dismissed", 1),
  o("acted", 0),
  o("ignored", 0),
];

describe("outcome report", () => {
  test("each outcome state is counted and the accepted ones are told from the rest", () => {
    const [g] = outcomeReport(history).workflows;
    expect(g!.states).toEqual({ merged: 1, closed: 1, kept: 1, dismissed: 1, acted: 1, ignored: 1 });
    expect([g!.accepted, g!.rejected]).toEqual([3, 3]);
  });

  test("cost per accepted outcome counts the spend on work that was not kept", () => {
    const [g] = outcomeReport(history).workflows;
    expect(g!.cost_usd).toBe(7);
    expect(g!.costPerAccepted).toBe(2.3333);
  });

  test("a workflow with nothing accepted has no cost per outcome, and an unknown cost hides the total", () => {
    const r = outcomeReport([o("closed", 4), o("merged", null, { workflow: "docs", team: "docs" })]);
    const byName = Object.fromEntries(r.workflows.map((g) => [g.name, g]));
    expect(byName["feature-to-pr"]!.cost_usd).toBe(4);
    expect("costPerAccepted" in byName["feature-to-pr"]!).toBe(false);
    expect(byName.docs!.unknownCost).toBe(1);
    expect("cost_usd" in byName.docs!).toBe(false);
    expect("costPerAccepted" in byName.docs!).toBe(false);
  });

  test("teams are grouped on their own", () => {
    const r = outcomeReport([...history, o("merged", 1, { team: "api" })]);
    expect(r.teams.map((t) => [t.name, t.costPerAccepted])).toEqual([
      ["api", 1],
      ["web", 2.3333],
    ]);
  });

  test("the window keeps outcomes settled from since up to, not including, until", () => {
    const r = outcomeReport(
      [
        o("merged", 1, { at: "2026-09-30T23:59:59Z" }),
        o("merged", 2, { at: "2026-10-01T00:00:00Z" }),
        o("merged", 4, { at: "2026-11-01T00:00:00Z" }),
      ],
      { since: "2026-10-01T00:00:00Z", until: "2026-11-01T00:00:00Z" },
    );
    expect(r.workflows[0]!.cost_usd).toBe(2);
  });

  test("two variants of one workflow are compared on cost per accepted outcome", () => {
    const r = outcomeReport([
      o("merged", 6, { workflow: "feature-to-pr__terse" }),
      o("closed", 6, { workflow: "feature-to-pr__terse" }),
      o("merged", 5, { workflow: "feature-to-pr__verbose" }),
      o("merged", 5, { workflow: "feature-to-pr__verbose" }),
      o("merged", 1, { workflow: "docs" }),
    ]);
    expect(r.variants).toHaveLength(1);
    const [v] = r.variants;
    expect(v!.workflow).toBe("feature-to-pr");
    expect(v!.variants.map((g) => [g.name, g.costPerAccepted])).toEqual([
      ["terse", 12],
      ["verbose", 5],
    ]);
    expect(v!.cheapest).toBe("verbose");
  });

  test("a lone variant is not a comparison", () => {
    expect(outcomeReport([o("merged", 1, { workflow: "feature-to-pr__terse" })]).variants).toEqual([]);
  });
});
