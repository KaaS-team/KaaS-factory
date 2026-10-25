// Ported from owainlewis/assembler@7cac671 test/runs.test.ts:81,126 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: events come from the state DB, so the UTF-8 split and path-escape cases are replaced by escape-code stripping and keyset paging; "step" is "stage".

import { expect, test } from "bun:test";
import { streamLogs } from "../../../src/logs";
import { FactoryState } from "../../../src/state";

function seeded(events: number) {
  const state = new FactoryState(":memory:");
  const run = state.upsertRun({ repo: "o/r", issue: 7, title: "t", stage: "build", status: "running" });
  for (let i = 0; i < events; i += 1) state.appendEvent(run.id, i < events / 2 ? "plan" : "build", "text", `line ${i}`);
  return { state, run };
}

test("step logs are filtered to the named stage and an unknown stage is an error", async () => {
  const { state, run } = seeded(4);
  state.updateRun("o/r", 7, { status: "shipped" });
  let text = "";
  await streamLogs(state, "o/r", 7, { stage: "build" }, (v) => (text += v));
  expect(text).toContain("line 3");
  expect(text).not.toContain("line 0");
  await expect(streamLogs(state, "o/r", 7, { stage: "absent" })).rejects.toThrow(/No stage/);
  expect(run.id).toBeGreaterThan(0);
});

test("--json prints one object per line, escape codes stripped, and pages past the 200 event limit", async () => {
  const { state, run } = seeded(450);
  state.appendEvent(run.id, "build", "text", "\x1b[2Jclear");
  state.updateRun("o/r", 7, { status: "shipped" });
  const lines: string[] = [];
  await streamLogs(state, "o/r", 7, { json: true }, (v) => lines.push(v));
  expect(lines).toHaveLength(451);
  const last = JSON.parse(lines.at(-1)!);
  expect(last).toEqual({ issue: 7, stage: "build", kind: "text", text: "clear" });
});

test("follow returns once the run is no longer active", async () => {
  const { state } = seeded(2);
  const seen: string[] = [];
  const done = streamLogs(state, "o/r", 7, { follow: true, pollMs: 5 }, (v) => seen.push(v));
  await Bun.sleep(30);
  state.appendEvent(state.getRun("o/r", 7)!.id, "build", "text", "late line");
  await Bun.sleep(30);
  state.updateRun("o/r", 7, { status: "shipped" });
  await done;
  expect(seen.join("")).toContain("late line");
});
