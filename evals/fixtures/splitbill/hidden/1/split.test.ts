import { expect, test } from "bun:test";
import { splitCents } from "../../src/money/cents";

test("split keeps every cent", () => {
  expect(splitCents(100, ["a", "b", "c"])).toEqual({ a: 34, b: 33, c: 33 });
});
