import { expect, test } from "bun:test";
import type { Finding } from "../src/artifacts";
import { describeTagged, tagFinding } from "../src/finding-check";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,2 +10,3 @@ fn",
  " ctx",
  "+new",
  " ctx",
].join("\n");

const f = (where: string | undefined, evidence: string | undefined): Finding => ({
  severity: "must",
  confidence: 4,
  what: "w",
  where,
  evidence,
});

test("a changed line with a reproduction is confirmed", () => {
  expect(tagFinding(f("src/a.ts:11", "run x"), DIFF)).toBe("confirmed");
});

test("a real location the diff did not change is pre-existing", () => {
  expect(tagFinding(f("src/a.ts:50", "run x"), DIFF)).toBe("pre-existing");
  expect(tagFinding(f("src/other.ts:3", "run x"), DIFF)).toBe("pre-existing");
});

test("no reproduction or no usable where is rejected", () => {
  expect(tagFinding(f("src/a.ts:11", undefined), DIFF)).toBe("rejected");
  expect(tagFinding(f(undefined, "run x"), DIFF)).toBe("rejected");
  expect(tagFinding(f("somewhere", "run x"), DIFF)).toBe("rejected");
});

test("describeTagged leads each bullet with its tag", () => {
  expect(describeTagged([f("src/a.ts:50", "e"), f(undefined, "e")], DIFF)).toBe("- [pre-existing] w\n- [rejected] w");
});
