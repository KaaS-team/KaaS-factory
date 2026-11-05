// preload.ts deletes the temp root after each run of a file, so under --rerun-each the second run
// finds it gone unless the file recreates it (#566, #585). rerun-baseline.json lists files not yet fixed; it only shrinks.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const baseline: string[] = JSON.parse(readFileSync(join(dir, "rerun-baseline.json"), "utf8"));
const leaky = (file: string): boolean => {
  const s = readFileSync(join(dir, file), "utf8");
  return /mkdtempSync\(/.test(s) && !s.includes("mkdirSync(tmpdir()");
};
const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts") && f !== "rerun-state.test.ts");

test("a test file that makes temp dirs recreates the temp root first, unless baselined", () => {
  expect(files.filter((f) => leaky(f) && !baseline.includes(f))).toEqual([]);
});

test("the baseline lists only files that still leak", () => {
  expect(baseline.filter((f) => !files.includes(f) || !leaky(f))).toEqual([]);
});

test("git and gates tests are fixed, not baselined", () => {
  expect(baseline).not.toContain("git.test.ts");
  expect(baseline).not.toContain("gates.test.ts");
  expect(leaky("git.test.ts") || leaky("gates.test.ts")).toBe(false);
});

test("make rerun runs git and gates under rerun-each, and ci.yml calls it", () => {
  const mk = readFileSync(join(dir, "..", "Makefile"), "utf8");
  expect(mk).toContain("RERUN_FILES = tests/git.test.ts tests/gates.test.ts");
  expect(mk).toContain('TEST_ARGS="--rerun-each 3"');
  expect(readFileSync(join(dir, "..", "ci", "ci.yml"), "utf8")).toContain("make rerun");
});
