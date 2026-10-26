import { expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Files over the limits are frozen at their size in quality-baseline.json, so each phase can only
// shrink them. The file list is walked here, not taken from git, so the mutation copy runs it too.
const ROOT = join(import.meta.dir, "..");
const SKIP = /(^|\/)(node_modules|target|reports|\.git)$|^scripts\/lwp$|^tests\/fixtures$/;
const sources = (dir = ROOT): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const rel = relative(ROOT, path);
    if (SKIP.test(rel)) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|js|mjs|py|sh)$/.test(rel) && !rel.endsWith(".d.ts") ? [rel] : [];
  });

test("no source file grows past its quality baseline", () => {
  const run = Bun.spawnSync(["python3", "scripts/lwp/check-quality.py", ...sources()], { cwd: ROOT });
  expect(
    run.stdout
      .toString()
      .split("\n")
      .filter((l) => l.includes("FAIL")),
  ).toEqual([]);
  expect(run.exitCode).toBe(0);
});
