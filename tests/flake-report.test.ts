import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FLAKE_LIMIT, type History, flakesIn, mustQuarantine, parseJunit, record } from "../scripts/flake-report";

const runs = parseJunit(readFileSync("tests/fixtures/flakes/rerun.xml", "utf8"));
const history = JSON.parse(readFileSync("tests/fixtures/flakes/history.json", "utf8")) as History;
const FLIP = "tests/a.test.ts::flips";

describe("flake report", () => {
  test("parseJunit adds up repeated testcases and ignores skipped ones", () => {
    expect(runs.get("tests/a.test.ts::steady")).toEqual({ pass: 3, fail: 0 });
    expect(runs.get(FLIP)).toEqual({ pass: 2, fail: 1 });
    expect(runs.has("tests/a.test.ts::not run")).toBe(false);
  });

  test("flakesIn returns only the test that flipped", () => {
    expect(flakesIn(runs)).toEqual([FLIP]);
  });

  test("record lifts the flipping test to FLAKE_LIMIT without mutating its input", () => {
    expect(history[FLIP]!.count).toBe(FLAKE_LIMIT - 1);
    const next = record(history, flakesIn(runs), "2026-10-30");
    expect(next[FLIP]).toEqual({ count: FLAKE_LIMIT, last: "2026-10-30" });
    expect(history[FLIP]!.count).toBe(FLAKE_LIMIT - 1);
    expect(mustQuarantine(next, runs)).toEqual([FLIP]);
    expect(mustQuarantine(history, runs)).toEqual([]);
  });

  test("a key at the limit that did not run is not named", () => {
    const atLimit: History = { "tests/gone.test.ts::x": { count: FLAKE_LIMIT, last: "2026-10-01" } };
    expect(mustQuarantine(atLimit, runs)).toEqual([]);
  });
});
