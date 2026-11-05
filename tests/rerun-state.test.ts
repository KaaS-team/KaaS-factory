// preload.ts empties the temp root after each run of a file and recreates it, so under --rerun-each the
// second run finds TMPDIR and FACTORY_HOME usable (#566, #585, #622). rerun-baseline.json is empty and stays empty.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = import.meta.dir;
const baseline: string[] = JSON.parse(readFileSync(join(dir, "rerun-baseline.json"), "utf8"));

test("the rerun baseline is empty: a test file that breaks on rerun is fixed, not listed", () => {
  expect(baseline).toEqual([]);
});

test("git and gates tests are fixed, not baselined", () => {
  expect(baseline).not.toContain("git.test.ts");
  expect(baseline).not.toContain("gates.test.ts");
});

test("a temp-dir test with no mkdirSync of its own passes under --rerun-each 3", () => {
  const work = mkdtempSync(join(tmpdir(), "rerun-proof-"));
  const file = join(work, "temp-dir.test.ts");
  writeFileSync(
    file,
    `import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("makes a temp dir and sees FACTORY_HOME", () => {
  expect(existsSync(process.env.FACTORY_HOME!)).toBe(true);
  expect(existsSync(mkdtempSync(join(tmpdir(), "x-")))).toBe(true);
});
`,
  );
  const proc = Bun.spawnSync(["bun", "test", "--preload", join(dir, "preload.ts"), "--rerun-each", "3", file], {
    cwd: work,
    env: { ...process.env, TMPDIR: work },
  });
  const out = proc.stdout.toString() + proc.stderr.toString();
  expect(out).toContain("3 pass");
  expect(proc.exitCode).toBe(0);
});

test("make rerun runs git and gates under rerun-each, and ci.yml calls it", () => {
  const mk = readFileSync(join(dir, "..", "Makefile"), "utf8");
  expect(mk).toContain("RERUN_FILES = tests/git.test.ts tests/gates.test.ts");
  expect(mk).toContain('TEST_ARGS="--rerun-each 3"');
  expect(readFileSync(join(dir, "..", "ci", "ci.yml"), "utf8")).toContain("make rerun");
});

test("make fast runs new and changed test files under --rerun-each 3, on the same file set as ci.yml", () => {
  const fast = readFileSync(join(dir, "..", "make", "fast.mk"), "utf8");
  expect(fast).toContain("--diff-filter=AM");
  expect(fast).toContain("'tests/*.test.ts'");
  expect(fast).toContain('TEST_ARGS="--rerun-each 3"');
});
