import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_LIMIT, readChecks, recordScore } from "../src/scored-checks";

function dir(): string {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), "scored-checks-"));
}

test("the first score has no previous and one entry in its history", () => {
  const file = join(dir(), "h.json");
  expect(recordScore(file, "judge", 7, 10)).toEqual({
    key: "judge",
    score: 7,
    max: 10,
    previous: undefined,
    last: [7],
  });
});

test("a second score carries the first as previous", () => {
  const file = join(dir(), "h.json");
  recordScore(file, "judge", 7, 10);
  expect(recordScore(file, "judge", 9, 10)).toEqual({ key: "judge", score: 9, max: 10, previous: 7, last: [7, 9] });
});

test("history keeps the last 10 scores only", () => {
  const file = join(dir(), "h.json");
  for (let i = 1; i <= 12; i++) recordScore(file, "qa", i, 20);
  const r = recordScore(file, "qa", 13, 20);
  expect(HISTORY_LIMIT).toBe(10);
  expect(r.last).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  expect(r.previous).toBe(12);
  const stored = JSON.parse(readFileSync(file, "utf8")) as { qa: { scores: number[] } };
  expect(stored.qa.scores).toHaveLength(10);
});

test("readChecks returns one row per key as recorded", () => {
  const file = join(dir(), "nested", "h.json");
  recordScore(file, "judge", 7, 10);
  recordScore(file, "qa", 3, 4);
  recordScore(file, "judge", 8, 10);
  expect(readChecks(file)).toEqual([
    { key: "judge", score: 8, max: 10, previous: 7, last: [7, 8] },
    { key: "qa", score: 3, max: 4, previous: undefined, last: [3] },
  ]);
});

test("a missing or corrupt history file reads as no checks", () => {
  const d = dir();
  const bad = join(d, "bad.json");
  writeFileSync(bad, "placeholder{");
  expect(readChecks(join(d, "none.json"))).toEqual([]);
  expect(readChecks(bad)).toEqual([]);
});

test("a score above max or a blank key is refused and nothing is written", () => {
  const file = join(dir(), "h.json");
  expect(() => recordScore(file, "judge", 11, 10)).toThrow("bad scored check");
  expect(() => recordScore(file, "", 1, 10)).toThrow("bad scored check");
  expect(readChecks(file)).toEqual([]);
});
