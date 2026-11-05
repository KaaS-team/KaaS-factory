// The open core builds and starts with ee/ absent, and the enterprise package is not in its sources.
import { expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("the core builds and runs `factory version` with ee/ deleted", () => {
  mkdirSync(tmpdir(), { recursive: true });
  const copy = mkdtempSync(join(tmpdir(), "no-ee-"));
  try {
    const skip = new Set(["ee", ".git", "node_modules", "tests", "docs", "target"]);
    for (const name of readdirSync(root))
      if (!skip.has(name)) cpSync(join(root, name), join(copy, name), { recursive: true });
    if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(copy, "node_modules"));
    expect(existsSync(join(copy, "ee"))).toBe(false);
    const build = Bun.spawnSync(["bun", "build", "bin/factory", "--target", "bun", "--outdir", "out"], {
      cwd: copy,
    });
    expect(build.stderr.toString()).toBe("");
    expect(build.exitCode).toBe(0);
    const run = Bun.spawnSync(["bun", "bin/factory", "version"], { cwd: copy });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim()).not.toBe("");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 60_000);
