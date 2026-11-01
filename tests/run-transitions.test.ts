import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryState, type RunStatus } from "../src/state";
import { ILLEGAL_TRANSITION_KIND, isLegal, settle, TRANSITION_KIND, transition } from "../src/run-transitions";

mkdirSync(tmpdir(), { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "factory-transitions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ALL: RunStatus[] = [
  "running",
  "needs-info",
  "awaiting-approval",
  "verifying",
  "rejected",
  "shipped",
  "failed",
  "needs-human",
  "cancelled",
];

test("lifecycle table: finished runs only leave by running, everything else moves freely", () => {
  for (const from of ALL)
    for (const to of ALL) {
      const finished = from === "shipped" || from === "cancelled";
      const expected = from === to || !finished || to === "running";
      expect(isLegal(from, to)).toBe(expected);
    }
});

function fresh(): FactoryState {
  const state = new FactoryState(join(dir, `${Math.random().toString(36).slice(2)}.db`));
  state.upsertRun({ issue: 1, repo: "acme/w", title: "t", stage: "build", status: "running" });
  return state;
}

test("transition writes the status and one event with from, to and reason", () => {
  const state = fresh();
  const rec = transition(state, "acme/w", 1, "failed", "gate red");
  expect(rec).toEqual({ from: "running", to: "failed", reason: "gate red" });
  const run = state.getRun("acme/w", 1)!;
  expect(run.status).toBe("failed");
  expect(run.reason).toBe("gate red");
  const events = state.listEvents(run.id);
  expect(events.map((e) => e.kind)).toEqual([TRANSITION_KIND]);
  expect(JSON.parse(events[0]!.text)).toEqual({ from: "running", to: "failed", reason: "gate red" });
});

test("an illegal move is applied but logged under its own kind", () => {
  const state = fresh();
  transition(state, "acme/w", 1, "shipped");
  transition(state, "acme/w", 1, "failed", "late");
  const run = state.getRun("acme/w", 1)!;
  expect(run.status).toBe("failed");
  expect(state.listEvents(run.id).map((e) => e.kind)).toEqual([TRANSITION_KIND, ILLEGAL_TRANSITION_KIND]);
});

test("an unknown run is a no-op", () => {
  expect(transition(fresh(), "acme/w", 99, "failed") === undefined).toBe(true);
});

test("settle closes the window for shipped, cancelled and failed only", () => {
  const closed: number[] = [];
  const view = {
    show: async () => {},
    close: async (n: number) => {
      closed.push(n);
    },
  };
  for (const to of ["needs-human", "awaiting-approval", "shipped"] as const) {
    const state = fresh();
    settle(state, view, "acme/w", 1, to);
  }
  expect(closed).toEqual([1]);
});
