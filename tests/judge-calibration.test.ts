// The recheck's labelled set: every case is what a human reviewer would say, and the step must
// agree with them above the pinned floors.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type CalibrationCase, PRECISION_FLOOR, RECALL_FLOOR, scoreRechecker } from "../src/calibration";

const cases = JSON.parse(readFileSync("tests/fixtures/judge-calibration/cases.json", "utf8")) as CalibrationCase[];

test("the set has at least 6 real and 6 not-real cases", () => {
  expect(cases.filter((c) => c.real).length).toBeGreaterThanOrEqual(6);
  expect(cases.filter((c) => !c.real).length).toBeGreaterThanOrEqual(6);
});

test("the recheck scores every case right and meets the floors", async () => {
  const score = await scoreRechecker(cases);
  expect(score.wrong).toEqual([]);
  expect(score.precision).toBeGreaterThanOrEqual(PRECISION_FLOOR);
  expect(score.recall).toBeGreaterThanOrEqual(RECALL_FLOOR);
});

test("a rechecker that keeps every finding scores below the precision floor", async () => {
  const keepAll = { supported: async (fs: readonly unknown[]) => fs.map((_, i) => i) };
  expect((await scoreRechecker(cases, keepAll)).precision).toBeLessThan(PRECISION_FLOOR);
});
