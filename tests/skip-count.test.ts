import { expect, test } from "bun:test";
import { skipDelta } from "../src/skip-count";

const diff = (path: string, removed: string[], added: string[]) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");

test("an added test.skip in a test file counts 1", () => {
  expect(skipDelta(diff("tests/a.test.ts", [], ['test.skip("x", () => {});']))).toBe(1);
});

test("removing a skip counts -1", () => {
  expect(skipDelta(diff("src/a.spec.ts", ['it.skip("x", () => {});'], []))).toBe(-1);
});

test("a skip in a non-test file counts 0", () => {
  expect(skipDelta(diff("src/a.ts", [], ['test.skip("x", () => {});']))).toBe(0);
});

test("a changed line that keeps its skip counts 0", () => {
  expect(skipDelta(diff("tests/a.test.ts", ['test.skip("old", f);'], ['test.skip("new", f);']))).toBe(0);
});

test("the other markers count", () => {
  const lines = ["describe.skip(", "test.fixme(", "test.todo(", "xit(", "xtest(", "foo.skip("];
  expect(skipDelta(diff("tests/a.test.ts", [], lines))).toBe(6);
});
