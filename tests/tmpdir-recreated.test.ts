import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `bun test --rerun-each` removes the shared tmpdir after the first pass, so a helper that calls
// mkdtempSync without recreating it throws ENOENT on the next one.
const MAKE = /mkdtempSync\(\s*join\(\s*tmpdir\(\)/g;
const MKDIR = /mkdirSync\(\s*tmpdir\(\)/g;

const helpers = readdirSync(import.meta.dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

test("the scan sees the shared helpers", () => {
  expect(helpers.includes("engine-harness.ts")).toBe(true);
  expect(helpers.includes("preload.ts")).toBe(true);
});

test("every mkdtempSync(join(tmpdir()) in a helper has a mkdirSync(tmpdir()) before it", () => {
  const bad: string[] = [];
  for (const f of helpers) {
    const src = readFileSync(join(import.meta.dir, f), "utf8");
    for (const m of src.matchAll(MAKE)) {
      const before = src.slice(0, m.index);
      if (!before.match(MKDIR)) bad.push(`${f}:${before.split("\n").length}`);
    }
  }
  expect(bad).toEqual([]);
});
