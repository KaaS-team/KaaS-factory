import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkValue, renderValue } from "../scripts/check-value";

const run = (issue: number, status: string) =>
  JSON.stringify({ v: 1, type: "run", issue, status, started_at: "2026-01-01T00:00:00Z" });
const stage = (issue: number, name: string, at: string, verdict: string | null = null, cost: number | null = 1) =>
  JSON.stringify({ v: 1, type: "stage", issue, stage: name, started_at: at, verdict, cost_usd: cost });
const t = (n: number) => `2026-01-01T00:0${n}:00Z`;
const lines = (...l: string[]) => l.join("\n");
const row = (jsonl: string, name: string) => checkValue(jsonl).rows.find((r) => r.name === name);

// Issue 1: reject in round 1, fixed, pass in round 2, shipped. Issue 2: pass in round 1.
const data = lines(
  run(1, "shipped"),
  stage(1, "build", t(0)),
  stage(1, "verify", t(1), "reject", 2),
  stage(1, "verify", t(2), "pass", 3),
  run(2, "shipped"),
  stage(2, "build", t(0)),
  stage(2, "verify", t(1), "pass", 2),
);

describe("check-value", () => {
  test("the round that rejected a shipped issue is first to catch", () => {
    expect(row(data, "verify round 1")).toMatchObject({ runs: 2, firstCatches: 1, costUsd: 4 });
    expect(row(data, "verify")).toMatchObject({ runs: 3, firstCatches: 1 });
  });

  test("a round that only confirmed a fix is named as never first, with its cost", () => {
    expect(row(data, "verify round 2")).toMatchObject({ runs: 1, firstCatches: 0, costUsd: 3 });
    expect(checkValue(data).neverFirst.map((r) => r.name)).toEqual(["verify round 2"]);
    expect(renderValue(checkValue(data))).toContain("- verify round 2 (round): 1 runs, $3.00");
  });

  test("a reject on an issue that did not ship is not a real defect", () => {
    const d = lines(run(3, "failed"), stage(3, "verify", t(1), "reject"));
    expect(checkValue(d).realDefects).toBe(0);
    expect(row(d, "verify round 1")?.firstCatches).toBe(0);
  });

  test("only the first reject on an issue is credited", () => {
    const d = lines(
      run(4, "shipped"),
      stage(4, "verify", t(1), "reject"),
      stage(4, "verify", t(2), "reject"),
      stage(4, "verify", t(3), "pass"),
    );
    expect(checkValue(d).realDefects).toBe(1);
    expect(row(d, "verify round 1")?.firstCatches).toBe(1);
    expect(row(d, "verify round 2")?.firstCatches).toBe(0);
  });

  test("a stage with no verdict is unmeasured, not named as never catching", () => {
    expect(checkValue(data).unmeasured).toEqual(["build"]);
    expect(checkValue(data).rows.map((x) => x.name)).not.toContain("build");
  });

  test("a stage run with no cost is counted as unpriced, not as free", () => {
    const d = lines(run(5, "shipped"), stage(5, "verify", t(1), "pass", null));
    expect(row(d, "verify round 1")).toMatchObject({ costUsd: 0, unknownCost: 1 });
  });

  test("the report states that a removal is its own issue", () => {
    expect(renderValue(checkValue(data))).toContain("A removal is its own issue");
  });

  test("the script reads an export file and prints the report", () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "check-value-"));
    try {
      writeFileSync(join(dir, "export.jsonl"), data);
      const p = Bun.spawnSync(["bun", "scripts/check-value.ts", join(dir, "export.jsonl")], {
        timeout: 60_000,
        cwd: `${import.meta.dir}/..`,
      });
      expect(p.exitCode).toBe(0);
      expect(p.stdout.toString()).toContain("| verify round 1 | round | 2 | 1 |");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
