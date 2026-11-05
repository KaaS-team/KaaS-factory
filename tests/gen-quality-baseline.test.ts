import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaseline, writeBaseline } from "../src/baseline-shards";
import { regenerate } from "../scripts/gen-quality-baseline";

const sizes = (m: Record<string, number>) => (f: string) => m[f];

test("lowers a shrunk file", () => {
  expect(regenerate({ "a.ts": 10 }, sizes({ "a.ts": 7 }), false).next).toEqual({ "a.ts": 7 });
});

test("keeps an unchanged file", () => {
  expect(regenerate({ "a.ts": 10 }, sizes({ "a.ts": 10 }), false)).toEqual({ next: { "a.ts": 10 }, raised: [] });
});

test("refuses a raise and reports it", () => {
  expect(regenerate({ "a.ts": 10 }, sizes({ "a.ts": 12 }), false)).toEqual({ next: { "a.ts": 10 }, raised: ["a.ts"] });
});

test("allows a raise with the flag", () => {
  expect(regenerate({ "a.ts": 10 }, sizes({ "a.ts": 12 }), true).next).toEqual({ "a.ts": 12 });
});

test("drops a deleted file", () => {
  expect(regenerate({ "a.ts": 10, "b.ts": 3 }, sizes({ "b.ts": 3 }), false).next).toEqual({ "b.ts": 3 });
});

test("--check exits 1 on a stale baseline and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qbaseline-"));
  writeFileSync(join(dir, "a.ts"), "x\ny\n");
  const baseline = join(dir, "quality-baseline");
  writeBaseline({ metrics: { lines: { "a.ts": 9 } } }, baseline);
  const shard = join(baseline, "lines/a.ts.json");
  const stale = readFileSync(shard, "utf8");
  const run = (...flags: string[]) =>
    Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "../scripts/gen-quality-baseline.ts"),
        "--root",
        dir,
        "--baseline",
        baseline,
        ...flags,
      ],
      { timeout: 60_000 },
    );
  const check = run("--check");
  expect(check.exitCode).toBe(1);
  expect(check.stderr.toString()).toContain("a.ts");
  expect(readFileSync(shard, "utf8")).toBe(stale);
  expect(run().exitCode).toBe(0);
  expect(run("--check").exitCode).toBe(0);
  expect(readBaseline(dir, baseline).metrics.lines).toEqual({ "a.ts": 2 });
});

test("--check fails on a shard that is not in canonical form", () => {
  const dir = mkdtempSync(join(tmpdir(), "qbaseline-"));
  writeFileSync(join(dir, "a.ts"), "x\ny\n");
  const baseline = join(dir, "quality-baseline");
  writeBaseline({ metrics: { lines: { "a.ts": 2 } } }, baseline);
  writeFileSync(join(baseline, "lines/stray.json"), '{"file":"a.ts","max":2}\n');
  const run = Bun.spawnSync(
    [
      "bun",
      join(import.meta.dir, "../scripts/gen-quality-baseline.ts"),
      "--root",
      dir,
      "--baseline",
      baseline,
      "--check",
    ],
    { timeout: 60_000, stderr: "pipe" },
  );
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain("lines/stray.json");
});
