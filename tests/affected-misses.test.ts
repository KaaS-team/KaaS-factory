import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a skipped check that fails writes a miss row and the issue names the check and the files", () => {
  const cfgPath = join(root, "repo.json");
  const log = join(root, "misses.jsonl");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const run = () =>
    Bun.spawnSync(
      [
        py,
        script,
        "--before",
        "abc",
        "--failed",
        "unit,docs",
        "--files",
        "src/a.ts",
        "--config",
        cfgPath,
        "--log",
        log,
      ],
      {
        cwd: join(import.meta.dir, ".."),
      },
    );
  const p = run();
  expect(p.stdout.toString()).toContain("affected-misses: 1 of 2 failures this push");
  expect(p.stdout.toString()).toContain("- docs: add");
  const row = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0] ?? "{}");
  expect(row.misses).toEqual(["docs"]);
  expect(row.failed).toBe(2);
  // The second push adds a row and the printed rate covers both: 2 misses over 4 failures.
  expect(run().stdout.toString()).toContain("Miss rate across 2 pushes: 0.5");
});

test("the issue body names the check, the changed files and the globs to add", () => {
  const driver = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("am", ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.title("docs"), m.body("docs", "abc123", ["src/a.ts", "src/b.ts"], ["src/a.ts"])]))`;
  const [title, body] = JSON.parse(run(driver)) as [string, string];
  expect(title).toBe("Affected-check miss: docs");
  expect(body).toContain("failed `docs`");
  expect(body).toContain("- `src/a.ts`");
  expect(body).toContain("- `src/b.ts`");
  expect(body).toContain('["src/a.ts"]');
});
