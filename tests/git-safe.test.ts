import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCommandRunner } from "../src/git";
import { SAFE_CONFIG, configFingerprint, safeArgs } from "../src/git-safe";

mkdirSync(tmpdir(), { recursive: true });
const root = mkdtempSync(join(tmpdir(), "git-safe-"));
const home = join(root, "home");
const repo = join(root, "repo");
const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, G: process.env.GIT_CONFIG_GLOBAL };

function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { timeout: 60_000, cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

beforeAll(() => {
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Global Person\n\temail = global@example.com\n");
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  delete process.env.XDG_CONFIG_HOME;
  sh(repo, "init", "-q");
  sh(repo, "config", "commit.gpgsign", "false");
});

afterAll(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore("HOME", saved.HOME);
  restore("XDG_CONFIG_HOME", saved.XDG);
  restore("GIT_CONFIG_GLOBAL", saved.G);
  rmSync(root, { recursive: true, force: true });
});

describe("safeArgs", () => {
  test("prepends the three pairs first and never duplicates", () => {
    expect(safeArgs(["status"])).toEqual([...SAFE_CONFIG, "status"]);
    expect(safeArgs(safeArgs(["status"]))).toEqual([...SAFE_CONFIG, "status"]);
    expect(SAFE_CONFIG.length).toBe(6);
  });
});

describe("GitCommandRunner", () => {
  test("a planted core.fsmonitor does not run on status", async () => {
    const marker = join(root, "marker");
    const script = join(root, "monitor.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    sh(repo, "config", "core.fsmonitor", script);
    const res = await new GitCommandRunner().run(["status"], { cwd: repo });
    expect(res.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    // control: without the safe flags the planted script does run
    Bun.spawnSync(["git", "status"], { timeout: 60_000, cwd: repo });
    expect(existsSync(marker)).toBe(true);
  });

  test("identity still comes from global config", async () => {
    const res = await new GitCommandRunner().run(["config", "user.name"], {
      cwd: repo,
      env: { GIT_CONFIG_GLOBAL: join(home, ".gitconfig") },
    });
    expect(res.stdout.trim()).toBe("Global Person");
  });
});

describe("configFingerprint", () => {
  test("changes with config or any hook, stable otherwise", () => {
    const gitDir = join(root, "fp");
    mkdirSync(join(gitDir, "hooks"), { recursive: true });
    writeFileSync(join(gitDir, "config"), "a");
    const base = configFingerprint(gitDir);
    expect(configFingerprint(gitDir)).toBe(base);
    writeFileSync(join(gitDir, "config"), "b");
    const afterConfig = configFingerprint(gitDir);
    expect(afterConfig).not.toBe(base);
    writeFileSync(join(gitDir, "hooks", "pre-commit"), "x");
    const afterHook = configFingerprint(gitDir);
    expect(afterHook).not.toBe(afterConfig);
    writeFileSync(join(gitDir, "hooks", "pre-commit"), "y");
    expect(configFingerprint(gitDir)).not.toBe(afterHook);
    writeFileSync(join(gitDir, "config.worktree"), "w");
    expect(configFingerprint(gitDir)).not.toBe(afterHook);
  });
});
