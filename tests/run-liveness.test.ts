// The board shows only what is true now: a run with no process and no recent event is interrupted,
// and a run whose issue closed is shipped or cancelled (#617).

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mergeConfig } from "../src/config";
import { pollOnce } from "../src/watch";
import { settleDeadRuns, STALE_RUN_MS } from "../src/run-liveness";
import { FactoryState } from "../src/state";
import { baseIssue, FakeGitHub } from "./harness";

const REPO = "acme/widgets";
const config = mergeConfig({ repo: REPO });

function world() {
  const state = new FactoryState(":memory:");
  const github = new FakeGitHub([baseIssue(1, []), baseIssue(2, []), baseIssue(3, [])]);
  for (const n of [1, 2, 3])
    state.upsertRun({ issue: n, repo: REPO, title: `t${n}`, stage: "verify", status: "running" });
  return { state, github, deps: { state, github } as never };
}
const statusOf = (s: FactoryState, n: number) => s.getRun(REPO, n)!.status;
const later = (ms: number) => Date.now() + ms;

describe("settleDeadRuns", () => {
  test("a run with no process behind it and no recent event is interrupted", async () => {
    const { state, deps } = world();
    expect(await settleDeadRuns(deps, config, new Set([2, 3]), later(STALE_RUN_MS + 60_000))).toEqual([1]);
    expect(statusOf(state, 1)).toBe("interrupted");
  });

  test("a run still inside the window, or held by this process, stays running", async () => {
    const { state, deps } = world();
    expect(await settleDeadRuns(deps, config, undefined, later(1000))).toEqual([]);
    expect(await settleDeadRuns(deps, config, new Set([1, 2, 3]), later(STALE_RUN_MS * 5))).toEqual([]);
    expect(statusOf(state, 1)).toBe("running");
  });

  test("a recent event keeps a quiet run alive", async () => {
    const { state, deps } = world();
    const run = state.getRun(REPO, 1)!;
    const soon = later(STALE_RUN_MS + 60_000);
    (state as unknown as { db: Database }).db
      .query("INSERT INTO events (run_id, ts, stage, kind, text) VALUES ($id, $ts, 'verify', 'x', 'y')")
      .run({
        $id: run.id,
        $ts: new Date(soon - 1000).toISOString(),
      } as never);
    expect(await settleDeadRuns(deps, config, new Set([2, 3]), soon)).toEqual([]);
    expect(statusOf(state, 1)).toBe("running");
  });

  test("a run whose issue closed is shipped when completed and cancelled otherwise", async () => {
    const { state, github, deps } = world();
    Object.assign(github.issues.get(2)!, { state: "CLOSED", stateReason: "COMPLETED" });
    Object.assign(github.issues.get(3)!, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    await settleDeadRuns(deps, config, new Set([1]), later(1000));
    expect(statusOf(state, 2)).toBe("shipped");
    expect(statusOf(state, 3)).toBe("cancelled");
    expect(statusOf(state, 1)).toBe("running");
  });
});

describe("pollOnce", () => {
  test("every poll ends a closed issue's run and a dead one", async () => {
    const { state, github, deps } = world();
    Object.assign(github.issues.get(2)!, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    await pollOnce({ ...(deps as object), now: () => new Date(Date.now() + 2 * STALE_RUN_MS) } as never, config);
    expect(statusOf(state, 1)).toBe("interrupted");
    expect(statusOf(state, 2)).toBe("cancelled");
  });
});
