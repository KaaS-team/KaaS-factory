// Ported from owainlewis/machinist@3943516 internal/runner/runner_test.go:340-395 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the log is the events table, and the bound counts stored text and kind bytes; TestEventLogTruncatesRecordingWithoutFailing's output limit is the executor's recorded-output cap and is asserted in agents.test.ts.

import { expect, test } from "bun:test";
import { TRUNCATION_KIND } from "../../../src/event-budget";
import { FactoryState } from "../../../src/state";

function fill(limit: number, chunks: number) {
  const state = new FactoryState(":memory:");
  state.eventByteLimit = limit;
  const run = state.upsertRun({ issue: 1, repo: "a/b", title: "t", stage: "build", status: "running" });
  for (let i = 0; i < chunks; i++) state.appendEvent(run.id, "build", "text", "x");
  return { state, events: state.listEvents(run.id, { limit: 5000 }) };
}

test("the event log is bounded across tiny chunks and ends with one truncation marker", () => {
  const { state, events } = fill(4 << 10, 1000);
  const stored = events.reduce((n, e) => n + e.text.length + e.kind.length, 0);
  expect(stored).toBeLessThanOrEqual(4 << 10);
  expect(events.filter((e) => e.kind === TRUNCATION_KIND)).toHaveLength(1);
  expect(events.at(-1)!.kind).toBe(TRUNCATION_KIND);
  state.close();
});

test("under the limit nothing is truncated", () => {
  const { state, events } = fill(1 << 20, 10);
  expect(events).toHaveLength(10);
  state.close();
});

test("a full run stays full", () => {
  const { state, events } = fill(2 << 10, 500);
  const before = events.length;
  const run = state.getRun("a/b", 1)!;
  state.appendEvent(run.id, "build", "text", "more");
  expect(state.listEvents(run.id, { limit: 5000 })).toHaveLength(before);
  state.close();
});
