// The ADR and walkthrough docs stay true to their own structure: each ADR has the five headings,
// the README indexes every ADR, every relative link resolves, and no em dash appears in them.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ADR_DIR = join(ROOT, "docs", "adr");
const WALK_DIR = join(ROOT, "docs", "walkthroughs");
const HEADINGS = ["Status", "Context", "Decision", "Consequences", "Alternatives considered"];
const LINK = /\]\(([^)\s]+)\)/g;

const mdFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".md"));
const adrs = () => mdFiles(ADR_DIR).filter((f) => f !== "README.md");
const docFiles = () => [
  ...mdFiles(ADR_DIR).map((f) => join(ADR_DIR, f)),
  ...mdFiles(WALK_DIR).map((f) => join(WALK_DIR, f)),
];

describe("docs/adr", () => {
  test("every ADR has the five headings", () => {
    expect(adrs().length).toBeGreaterThan(0);
    for (const f of adrs()) {
      const text = readFileSync(join(ADR_DIR, f), "utf8");
      for (const h of HEADINGS) expect({ file: f, has: text.includes(`## ${h}\n`) }).toEqual({ file: f, has: true });
    }
  });

  test("README lists every ADR file", () => {
    const readme = readFileSync(join(ADR_DIR, "README.md"), "utf8");
    for (const f of adrs()) expect({ file: f, listed: readme.includes(`(${f})`) }).toEqual({ file: f, listed: true });
  });
});

describe("docs/adr and docs/walkthroughs", () => {
  test("every relative link resolves to a file", () => {
    for (const file of docFiles()) {
      for (const m of readFileSync(file, "utf8").matchAll(LINK)) {
        const target = m[1]!;
        if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
        const path = resolve(dirname(file), target.split("#")[0]!);
        expect({ from: file, target, exists: existsSync(path) }).toEqual({ from: file, target, exists: true });
      }
    }
  });

  test("no em dash appears", () => {
    for (const file of docFiles()) {
      expect({ file, emDash: readFileSync(file, "utf8").includes("—") }).toEqual({ file, emDash: false });
    }
  });
});
