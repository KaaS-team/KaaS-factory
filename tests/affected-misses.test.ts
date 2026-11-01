import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// check-affected.py uses f-strings that need Python 3.12.
const py = ["python3.13", "python3.12", "python3"].find((b) => Bun.which(b)) ?? "python3";
const script = join(import.meta.dir, "..", "scripts", "affected-misses.py");
const cfg = {
  gate: "make check",
  impact: {
    checks: [
      { name: "unit", when: ["src/**"], run: "echo unit" },
      { name: "docs", when: ["docs/**"], run: "echo docs" },
      { name: "nightly", when: ["e2e/**"], run: "echo e2e", stage: "nightly" },
    ],
  },
};

let root = "";
beforeAll(() => {
  mkdirSync(tmpdir(), { recursive: true });
  root = mkdtempSync(join(tmpdir(), "affected-misses-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(driver: string): string {
  const p = Bun.spawnSync([py, "-I", "-c", driver], { cwd: root });
  expect(p.stderr.toString()).toBe("");
  return p.stdout.toString().trim();
}

function missesFor(c: unknown, files: string[], failed: string[]): string[] {
  const driver = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("am", ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
from pathlib import Path
print(json.dumps(m.misses(json.loads(${JSON.stringify(JSON.stringify(c))}), ${JSON.stringify(files)}, ${JSON.stringify(failed)}, Path(${JSON.stringify(root)}))))`;
  return JSON.parse(run(driver));
}

test("a failed check the selection ran is not a miss", () => {
  expect(missesFor(cfg, ["src/a.ts"], ["unit"])).toEqual([]);
});

test("a failed check the selection skipped is a miss", () => {
  expect(missesFor(cfg, ["src/a.ts"], ["unit", "docs"])).toEqual(["docs"]);
});

test("a check owned by a later stage is not a miss", () => {
  expect(missesFor(cfg, ["src/a.ts"], ["nightly"])).toEqual([]);
});

test("a change no check claims runs the whole gate, so nothing is missed", () => {
  expect(missesFor(cfg, ["mystery.bin"], ["docs"])).toEqual([]);
});

test("the script logs a row and prints the globs to add", () => {
  const p = Bun.spawnSync([py, script, "--before", "abc", "--failed", "unit", "--files", "docs/x.md"], {
    cwd: join(import.meta.dir, ".."),
  });
  expect(p.stdout.toString()).toContain("affected-misses: 0 of 1 failures this push");
  const rows = readFileSync(join(import.meta.dir, "..", "reports", "affected-misses.jsonl"), "utf8")
    .trim()
    .split("\n");
  expect(JSON.parse(rows[rows.length - 1] ?? "{}").failed).toBe(1);
  rmSync(join(import.meta.dir, "..", "reports", "affected-misses.jsonl"));
});
