// Mutants on the changed lines only: a line the tests check kills its mutant, one they skip survives.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutantsFor, runChangedLineMutants } from "../src/changed-mutants";

test("verify runs mutants on the changed lines of every PR and reports the lines no test checks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mutants-"));
  mkdirSync(join(dir, "src"));
  const source =
    "export const adult = (age: number) => age >= 18;\nexport const shout = (on: boolean) => on === true;\n";
  writeFileSync(join(dir, "src/rules.ts"), source);
  const diff =
    "diff --git a/src/rules.ts b/src/rules.ts\n--- a/src/rules.ts\n+++ b/src/rules.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n";
  expect(mutantsFor(diff, () => source).map((m) => m.after)).toEqual([
    "export const adult = (age: number) => age < 18;",
    "export const shout = (on: boolean) => on !== true;",
  ]);
  // The test command checks `adult` only, so the mutant on `shout` survives.
  const cmd = `bun -e 'const r = await import("./src/rules.ts"); process.exit(r.adult(20) && !r.adult(3) ? 0 : 1)'`;
  const result = await runChangedLineMutants(dir, diff, cmd);
  expect(result).toEqual({ mutants: 2, survived: ["src/rules.ts:2"] });
  expect(readFileSync(join(dir, "src/rules.ts"), "utf8")).toBe(source);
  // A test file's own lines are never mutated.
  expect(mutantsFor(diff.replaceAll("src/rules.ts", "tests/rules.test.ts"), () => source)).toEqual([]);
});
