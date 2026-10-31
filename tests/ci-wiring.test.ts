import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// The workflows are staged under ci/ until the operator moves them to .github/workflows/.
const runs = (script: string, files: string[]): boolean =>
  files.some((f) => existsSync(f) && readFileSync(f, "utf8").includes(`bun ${script}`));

describe("ci wiring", () => {
  test("scripts/check-tests-only.ts is run by ci.yml", () => {
    expect(runs("scripts/check-tests-only.ts", [".github/workflows/ci.yml", "ci/ci.yml"])).toBe(true);
  });

  test("scripts/flake-report.ts is run by flakes.yml", () => {
    expect(runs("scripts/flake-report.ts", [".github/workflows/flakes.yml", "ci/flakes.yml"])).toBe(true);
  });

  test("make check lists check-anchors", () => {
    const line = readFileSync("Makefile", "utf8")
      .split("\n")
      .find((l) => l.startsWith("check:"));
    expect(line?.split(/\s+/)).toContain("check-anchors");
  });
});
