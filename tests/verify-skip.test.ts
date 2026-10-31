import { expect, test } from "bun:test";
import { skipRiseHits } from "../src/engine/verify-facts";

const diff = (removed: string[], added: string[]) =>
  [
    "diff --git a/tests/a.test.ts b/tests/a.test.ts",
    "--- a/tests/a.test.ts",
    "+++ b/tests/a.test.ts",
    "@@ -1,1 +1,1 @@",
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");

test("a diff that adds test.skip fails verify, naming the file", () => {
  const hits = skipRiseHits(diff([], ['test.skip("x", f);']));
  expect(hits).toHaveLength(1);
  expect(hits[0]).toContain("tests/a.test.ts");
  expect(hits[0]).toContain("needs a person");
});

test("a diff that deletes a skip passes", () => {
  expect(skipRiseHits(diff(['test.skip("x", f);'], []))).toEqual([]);
});
