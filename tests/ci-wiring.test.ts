import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The workflows are staged under ci/ until the operator moves them to .github/workflows/.
const runs = (script: string, files: string[]): boolean =>
  files.some((f) => existsSync(f) && readFileSync(f, "utf8").includes(`bun ${script}`));

const TABLE = "tests/ci-wiring";

type Entry = { script?: string; scripts?: string[]; workflows?: string[] };

const load = (name: string): Entry => JSON.parse(readFileSync(join(TABLE, name), "utf8")) as Entry;

const checkEntry = (entry: Entry): void => {
  const scripts = entry.scripts ?? (entry.script ? [entry.script] : []);
  const workflows = entry.workflows ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  expect(workflows.length).toBeGreaterThan(0);
  for (const script of scripts) expect(runs(script, workflows)).toBe(true);
};

const prerequisites = (): string[] => {
  const out = Bun.spawnSync(["make", "-pn", "check"]).stdout.toString();
  const line = out.split("\n").find((l) => l.startsWith("check:"));
  return line?.slice("check:".length).trim().split(/\s+/) ?? [];
};

describe("ci wiring", () => {
  const files = readdirSync(TABLE)
    .filter((f) => f.endsWith(".json"))
    .sort();

  test("the table is not empty", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} scripts are run by their workflows`, () => {
      checkEntry(load(file));
    });
  }

  test("an entry with no workflows fails", () => {
    expect(() => checkEntry({ script: "scripts/x.ts" })).toThrow();
  });

  test("an entry listing a missing workflow fails", () => {
    expect(() => checkEntry({ script: "scripts/x.ts", workflows: ["ci/does-not-exist.yml"] })).toThrow();
  });

  test("an entry whose script no workflow runs fails", () => {
    expect(() => checkEntry({ script: "scripts/no-workflow-runs-this.ts", workflows: ["ci/ci.yml"] })).toThrow();
  });

  test("make check lists check-baseline", () => {
    expect(prerequisites()).toContain("check-baseline");
  });

  test("make check lists check-anchors", () => {
    expect(prerequisites()).toContain("check-anchors");
  });
});
