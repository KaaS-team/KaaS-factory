import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedLines, diffCoverage, parseLcov } from "../scripts/diff-coverage";

const LCOV = [
  "SF:src/a.ts",
  "DA:1,3",
  "DA:2,0",
  "DA:5,1",
  "DA:9,0",
  "end_of_record",
  "SF:src/b.ts",
  "DA:1,1",
  "end_of_record",
].join("\n");
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,0 +1,2 @@",
  "+one",
  "+two",
  "@@ -4,1 +5,2 @@",
  " ctx",
  "+added",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-x",
  "+y",
].join("\n");

describe("diff coverage", () => {
  test("parseLcov reads files, lines and hit counts", () => {
    const l = parseLcov(LCOV);
    expect([...l.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(l.get("src/a.ts")?.get(2)).toBe(0);
    expect(l.get("src/a.ts")?.get(1)).toBe(3);
  });

  test("changedLines reads new-side numbers across hunks", () => {
    const c = changedLines(DIFF);
    expect(c.get("src/a.ts")).toEqual([1, 2, 6]);
    expect(c.get("README.md")).toEqual([1]);
  });

  test("a hit line is covered and a DA:n,0 line is listed as uncovered", () => {
    const r = diffCoverage(parseLcov(LCOV), new Map([["src/a.ts", [1, 2]]]));
    expect(r.covered).toBe(1);
    expect(r.total).toBe(2);
    expect(r.pct).toBe(50);
    expect(r.uncovered).toEqual([{ file: "src/a.ts", line: 2 }]);
  });

  test("a line with no DA record is excluded from the total", () => {
    const r = diffCoverage(parseLcov(LCOV), new Map([["src/a.ts", [1, 3, 4]]]));
    expect(r.total).toBe(1);
    expect(r.covered).toBe(1);
  });

  test("multi-hunk diff against lcov only counts executable changed lines", () => {
    const r = diffCoverage(parseLcov(LCOV), changedLines(DIFF));
    expect(r.total).toBe(2);
    expect(r.covered).toBe(1);
    expect(r.uncovered).toEqual([{ file: "src/a.ts", line: 2 }]);
  });

  test("a diff touching no source line gives total 0 and passes", () => {
    const r = diffCoverage(parseLcov(LCOV), new Map([["README.md", [1]]]));
    expect(r.total).toBe(0);
    expect(r.pct).toBe(100);
  });
});

describe("diff coverage CLI", () => {
  const run = (min: string): number => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "diffcov-"));
    const git = (...a: string[]) =>
      Bun.spawnSync(
        ["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...a],
        { cwd: dir },
      );
    git("init", "-q");
    writeFileSync(join(dir, "f.ts"), "a\n");
    git("add", "f.ts");
    git("commit", "-q", "-m", "base");
    writeFileSync(join(dir, "f.ts"), "a\nb\nc\n");
    const lcov = join(dir, "lcov.info");
    writeFileSync(lcov, "SF:f.ts\nDA:2,1\nDA:3,0\nend_of_record\n");
    const script = join(process.cwd(), "scripts/diff-coverage.ts");
    return Bun.spawnSync(["bun", script, lcov, "HEAD", "--min", min], { cwd: dir }).exitCode;
  };

  test("below --min the CLI exits 1 and at or above it exits 0", () => {
    expect(run("80")).toBe(1);
    expect(run("50")).toBe(0);
  });
});
