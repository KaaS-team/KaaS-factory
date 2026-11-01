// A review finding is acted on when the next commit changes a line it points at.
import { expect, test } from "bun:test";
import type { Finding } from "../src/artifacts";
import { measureActed } from "../src/review-acted";

const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,2 +10,3 @@", " x", "+y", " z"].join("\n");
const f = (where?: string): Finding => ({ severity: "must", confidence: 4, what: `at ${where}`, where });

test("a finding whose lines the next diff changed is acted, others are not", () => {
  const r = measureActed([f("src/a.ts:11"), f("src/a.ts:40"), f("src/b.ts:11"), f("src/a.ts:2")], diff);
  expect(r.findings.map((x) => x.acted)).toEqual([true, false, false, false]);
  expect(r.acted).toBe(1);
  expect(r.anchored).toBe(4);
  expect(r.rate).toBeCloseTo(1 / 4, 5);
});

test("a range overlapping a hunk counts", () => {
  expect(measureActed([f("./src/a.ts:8-10")], diff).acted).toBe(1);
});

test("string and unanchored findings stay out of the rate", () => {
  const r = measureActed(["vague", f(undefined), f("src/a.ts:10")], diff);
  expect(r.anchored).toBe(1);
  expect(r.acted).toBe(1);
  expect(r.rate).toBe(1);
});

test("no placeable finding gives no rate", () => {
  expect(measureActed(["vague"], diff).rate).toBeUndefined();
  expect(measureActed([], diff).rate).toBeUndefined();
});
