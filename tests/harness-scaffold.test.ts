// `factory harness scaffold` writes a starting .md workflow that loads and drives an issue, and
// `factory harness eval` scores each workflow from the runs the event log recorded.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/engine/bus";
import { loadWorkflow } from "../src/engine/workflows";
import { evalRuns, formatScores, harnessReport, scaffoldWorkflow } from "../src/harness";
import { FactoryState } from "../src/state";
import { engine, removeEngineDirs } from "./engine-harness";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  removeEngineDirs();
});
const clone = () => {
  const d = mkdtempSync(join(tmpdir(), "factory-scaffold-"));
  dirs.push(d);
  return d;
};
const PLAN = {
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
  "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: false }),
};
const CONFIG = { repo: "acme/widgets", workflow: "feature-to-pr", routes: {} };

describe("factory harness scaffold and eval", () => {
  test("scaffold writes a .md workflow that validate lists and that ships an issue, and never overwrites", async () => {
    const dir = clone();
    expect(scaffoldWorkflow(dir, "release")).toEqual({ path: ".factory/workflows/release.md" });
    const report = await harnessReport(dir, CONFIG);
    const entry = report.entries.find((e) => e.name === "release");
    expect(entry).toMatchObject({ source: "repo", problems: [] });
    expect(report.problems).toEqual([]);
    const loaded = await loadWorkflow(dir, "release");
    if (!loaded.ok) throw new Error(loaded.problems.join("; "));
    expect(Object.keys(loaded.workflow.steps)).toEqual(["triage", "plan", "build", "build-gates", "verify", "pr"]);
    expect(await engine(loaded.workflow, 0, {}, {}, {}, { outputs: { plan: [PLAN] } }).run()).toBe("shipped");

    writeFileSync(join(dir, ".factory", "workflows", "release.md"), "mine");
    expect(scaffoldWorkflow(dir, "release")).toEqual({
      problems: [".factory/workflows/release.md exists; scaffold never overwrites"],
    });
    expect(readFileSync(join(dir, ".factory", "workflows", "release.md"), "utf8")).toBe("mine");
    expect(scaffoldWorkflow(dir, "../x")).toEqual({ problems: ['"../x": letters, digits, - and _ only'] });
  });

  test("eval scores each workflow's recorded runs: shipped rate, failed steps and cost", async () => {
    const dir = clone();
    scaffoldWorkflow(dir, "release");
    const loaded = await loadWorkflow(dir, "release");
    if (!loaded.ok) throw new Error(loaded.problems.join("; "));
    const state = new FactoryState(":memory:");
    const bus = new EventBus({
      store: state,
      sinks: [],
      source: "factory/acme/widgets",
      autoDeliver: false,
      log: () => {},
    });
    const opts = { outputs: { plan: [PLAN] } };
    expect(await engine(loaded.workflow, 0, {}, {}, { state, bus }, opts).run()).toBe("shipped");
    // A build that writes no valid artifact fails its step, so the run does not ship.
    const broken = {
      outputs: { plan: [PLAN], build: [{ "build.json": "{}" }, { "build.json": "{}" }, { "build.json": "{}" }] },
    };
    expect(await engine(loaded.workflow, 0, {}, {}, { state, bus }, broken).run()).not.toBe("shipped");
    const rows = state.busEvents(1000);
    const failedSteps = rows.filter((r) => r.type === "factory.step.failed").map((r) => JSON.parse(r.data).step);
    expect(failedSteps.length).toBeGreaterThan(0);
    state.recordStageRun({
      ...{ repo: "acme/widgets", issue: 1, stage: "build", agent: "claude", model: null },
      ...{ started_at: new Date().toISOString(), finished_at: new Date().toISOString(), duration_ms: 1 },
      ...{ tool_calls: 1, tokens_in: 1, tokens_out: 1, tokens_cached: 0, cost_usd: 0.25, usage_complete: 1 },
      ...{ exit_code: 0, killed_reason: null, session_id: null },
    });

    const [score, ...rest] = evalRuns(
      rows,
      "acme/widgets",
      (i) => state.spendSummary("acme/widgets", "1970", i).costUsd,
    );
    expect(rest).toEqual([]);
    expect(score).toMatchObject({ workflow: "release", runs: 2, shippedRate: 0.5, issues: [1] });
    expect(score!.outcomes.shipped).toBe(1);
    expect(Object.values(score!.failedSteps).reduce((a, b) => a + b, 0)).toBe(failedSteps.length);
    expect(score!.costUsd).toBeCloseTo(state.spendSummary("acme/widgets", "1970", 1).costUsd);
    expect(score!.costUsd).toBeGreaterThanOrEqual(0.25);
    expect(evalRuns(rows, "someone/else", () => 0)).toEqual([]);
    expect(formatScores([score!])[0]).toStartWith("release: 2 runs, 50% shipped, $");
  });
});
