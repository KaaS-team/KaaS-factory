import { describe, expect, test } from "bun:test";
import { checksOf, closePr, closeVerify, flushChecks, noteCheck, noteFinding } from "../src/stage-checks";
import { FactoryState } from "../src/state";

const repo = "acme/checks";
const row = (state: FactoryState) => state.listStageRuns(repo)[0]!;

describe("stage checks", () => {
  test("flush stamps the newest row of the stage with checks and findings, then clears", () => {
    const state = new FactoryState(":memory:");
    state.recordStageRun({
      repo,
      issue: 7,
      stage: "build",
      agent: "claude",
      model: null,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:00Z",
      duration_ms: 1,
      tool_calls: 0,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: null,
      exit_code: 0,
      killed_reason: null,
    });
    noteCheck(repo, 7, "gates", false, "gates red");
    noteFinding(repo, 7, { check: "reviewer", severity: "should", what: "y" });
    flushChecks(state, repo, 7, "build");
    expect(checksOf(row(state)).checks).toEqual([{ name: "gates", result: "fail" }]);
    expect(checksOf(row(state)).findings).toEqual([
      { check: "gates", severity: "must", what: "gates red" },
      { check: "reviewer", severity: "should", what: "y" },
    ]);
    flushChecks(state, repo, 7, "build");
    expect(checksOf(row(state)).checks).toHaveLength(1);
  });
});
