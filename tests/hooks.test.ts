// The hooks in .githooks, run by real git in a temp repo: commit-msg signs off once, pre-push refuses
// an unsigned commit, and install-hooks.ts sets core.hooksPath.

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(30_000);

const REPO = resolve(import.meta.dir, "..");
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "factory-hooks-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test Author");
  git(root, "config", "user.email", "test@example.com");
  return root;
}

function withHooks(root: string): void {
  git(root, "config", "core.hooksPath", join(REPO, ".githooks"));
}

function prePush(): string {
  return JSON.parse(readFileSync(join(REPO, ".agents/repo.json"), "utf8")).prePush;
}

function signoffs(root: string): string[] {
  return git(root, "log", "-1", "--format=%B")
    .out.split("\n")
    .filter((l) => l.startsWith("Signed-off-by:"));
}

describe("commit-msg", () => {
  test("an unsigned commit gains exactly one sign-off, and -s adds no second", () => {
    const root = tmpRepo();
    withHooks(root);
    writeFileSync(join(root, "a"), "1");
    git(root, "add", "a");
    expect(git(root, "commit", "-q", "-m", "one").code).toBe(0);
    expect(signoffs(root)).toEqual(["Signed-off-by: Test Author <test@example.com>"]);
    expect(git(root, "log", "-1", "--format=%B").out).not.toMatch(/Claude-Session|https?:/);

    writeFileSync(join(root, "a"), "2");
    expect(git(root, "commit", "-q", "-s", "-a", "-m", "two").code).toBe(0);
    expect(signoffs(root)).toHaveLength(1);
  });
});

describe("pre-push", () => {
  test("repo.json prePush runs the DCO check and biome", () => {
    expect(prePush()).toContain("bun scripts/dco.ts");
    expect(prePush()).toContain("bun x biome ci .");
  });

  test("the hook is the kit stub, byte for byte", () => {
    expect(readFileSync(join(REPO, ".githooks/pre-push"), "utf8")).toBe(
      "#!/bin/sh\n" +
        "# Written by the kaas kit (scripts/sync-vendored.py); the gate is scripts/kaas/pre-push.sh.\n" +
        'exec scripts/kaas/pre-push.sh "$@"\n',
    );
  });

  test("a push of an unsigned commit is refused", () => {
    const root = tmpRepo();
    const remote = tmpRepo();
    git(remote, "config", "receive.denyCurrentBranch", "ignore");
    // The hook runs from the working tree root: give the temp repo the scripts it calls.
    mkdirSync(join(root, "scripts/kaas"), { recursive: true });
    copyFileSync(join(REPO, "scripts/dco.ts"), join(root, "scripts/dco.ts"));
    copyFileSync(join(REPO, "scripts/kaas/pre-push.sh"), join(root, "scripts/kaas/pre-push.sh"));
    copyFileSync(join(REPO, "scripts/kaas/check-repo.py"), join(root, "scripts/kaas/check-repo.py"));
    // The audit and the gate are not under test here: stub them, and keep the real prePush command.
    writeFileSync(join(root, "scripts/kaas/check-affected.py"), "");
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, ".agents/repo.json"), JSON.stringify({ prePush: prePush() }));
    git(root, "remote", "add", "origin", remote);
    writeFileSync(join(root, "a"), "1");
    git(root, "add", "-A");
    expect(git(root, "commit", "-q", "-s", "-m", "base").code).toBe(0);
    expect(git(root, "push", "-q", "origin", "main", "--no-verify").code).toBe(0);
    writeFileSync(join(root, "a"), "2");
    expect(git(root, "commit", "-q", "-a", "-m", "unsigned").code).toBe(0);
    withHooks(root);
    const r = git(root, "push", "origin", "main");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("has no Signed-off-by");
    expect(r.out).toContain("pre-push: `bun scripts/dco.ts");
  });
});

describe("install-hooks", () => {
  test("sets core.hooksPath to .githooks, twice over", () => {
    const root = tmpRepo();
    for (let i = 0; i < 2; i++) {
      const r = Bun.spawnSync(["bun", join(REPO, "scripts/install-hooks.ts")], { cwd: root });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString().trim().split("\n")).toHaveLength(1);
      expect(git(root, "config", "core.hooksPath").out.trim()).toBe(".githooks");
    }
  });
});
