import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { KINDS, findings, isTestFile, parseDiff, problems } from "../scripts/check-tests-only";

const DIR = "tests/fixtures/tests-only";
const read = (name: string): string => readFileSync(`${DIR}/${name}`, "utf8");
const REASON = "Test change reason: renamed a helper, no assertion lost";

describe("check-tests-only fixtures", () => {
  test("every kind has a fixture that yields a finding of that kind", () => {
    for (const kind of KINDS) {
      const kinds = findings(parseDiff(read(`${kind}.diff`))).map((f) => f.kind);
      expect(kinds).toContain(kind);
    }
  });

  test("every fixture but clean.diff fails without a reason and passes with one", () => {
    const names = readdirSync(DIR).filter((n) => n !== "clean.diff");
    expect(names.length).toBe(KINDS.length);
    for (const name of names) {
      expect(problems(read(name), "").length).toBeGreaterThan(1);
      expect(problems(read(name), REASON)).toEqual([]);
    }
  });

  test("a fixture trips only its own kind (only-tests may trip others)", () => {
    for (const kind of KINDS.filter((k) => k !== "only-tests")) {
      const kinds = new Set(findings(parseDiff(read(`${kind}.diff`))).map((f) => f.kind));
      expect([...kinds]).toEqual([kind]);
    }
  });

  test("clean.diff yields no finding and no problem", () => {
    expect(findings(parseDiff(read("clean.diff")))).toEqual([]);
    expect(problems(read("clean.diff"), "")).toEqual([]);
  });

  test("a rewritten assertion is not a removal", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/tests/a.test.ts b/tests/a.test.ts",
      "--- a/tests/a.test.ts",
      "+++ b/tests/a.test.ts",
      "@@ -1 +1 @@",
      "-  expect(a()).toBe(1);",
      "+  expect(a()).toBe(2);",
    ].join("\n");
    expect(findings(parseDiff(diff))).toEqual([]);
  });

  test("a reason shorter than 10 characters is refused", () => {
    expect(problems(read("new-skip.diff"), "Test change reason: short")).not.toEqual([]);
    expect(problems(read("new-skip.diff"), "Test change reason: ten chars!")).toEqual([]);
  });

  test("a deleted test file takes its path from the a side", () => {
    const diff = [
      "diff --git a/tests/gone.test.ts b/tests/gone.test.ts",
      "deleted file mode 100644",
      "--- a/tests/gone.test.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
    ].join("\n");
    expect(parseDiff(diff)).toEqual([{ path: "tests/gone.test.ts", deleted: true, added: [], removed: ["x"] }]);
    expect(findings(parseDiff(diff)).map((f) => f.kind)).toContain("deleted-test");
  });

  test("isTestFile", () => {
    for (const p of [
      "tests/a.ts",
      "test/a.ts",
      "x/tests/y.json",
      "a.test.ts",
      "a.spec.tsx",
      "a.test.mjs",
      "a_test.go",
      "a_test.py",
      "pkg/test_a.py",
    ])
      expect(isTestFile(p)).toBe(true);
    for (const p of ["src/a.ts", "scripts/latest.ts", "a.test.md", "src/contest.py"]) expect(isTestFile(p)).toBe(false);
  });
});
