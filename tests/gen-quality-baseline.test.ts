import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const baseline = join(dir, "quality-baseline.json");
  const stale = `${JSON.stringify({ comments: {}, lines: { "a.ts": 9 } }, null, 2)}\n`;
  writeFileSync(baseline, stale);
  const run = (...flags: string[]) =>
    Bun.spawnSync([
      "bun",
      join(import.meta.dir, "../scripts/gen-quality-baseline.ts"),
      "--root",
      dir,
      "--baseline",
      baseline,
      ...flags,
    ]);
  const check = run("--check");
  expect(check.exitCode).toBe(1);
  expect(check.stderr.toString()).toContain("a.ts");
  expect(await Bun.file(baseline).text()).toBe(stale);
  expect(run().exitCode).toBe(0);
  expect(run("--check").exitCode).toBe(0);
  expect(JSON.parse(await Bun.file(baseline).text()).lines).toEqual({ "a.ts": 2 });
});
