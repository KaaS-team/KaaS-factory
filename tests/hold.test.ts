// A held run refuses the runner's push; release lets it through. Real git, own temp dir per test.

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git, GitCommandRunner } from "../src/git";
import { heldRefusal, holdMarker, holdRun, isHeld, releaseRun } from "../src/hold";
import { runHoldCommand } from "../src/hold-cli";

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const r = mkdtempSync(join(tmpdir(), "factory-hold-"));
  roots.push(r);
  return r;
}

function sh(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], { timeout: 60_000, cwd });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
}

function repoWithRemote(): { work: string; remote: string } {
  const root = tmp();
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  mkdirSync(work);
  sh(root, "init", "--bare", remote);
  sh(work, "init", "-b", "main");
  sh(work, "config", "commit.gpgsign", "false");
  sh(work, "config", "user.email", "t@example.com");
  sh(work, "config", "user.name", "t");
  sh(work, "remote", "add", "origin", remote);
  writeFileSync(join(work, "a.txt"), "a\n");
  sh(work, "add", ".");
  sh(work, "commit", "-m", "a");
  return { work, remote };
}

describe("hold", () => {
  test("marker lives beside the worktree and toggles", () => {
    const dir = join(tmp(), "issue-7");
    expect(holdMarker(`${dir}/`)).toBe(`${dir}.hold`);
    expect(isHeld(dir)).toBe(false);
    holdRun(dir, "alice");
    expect(isHeld(dir)).toBe(true);
    expect(heldRefusal(dir)?.code).toBe(1);
    expect(releaseRun(dir)).toBe(true);
    expect(releaseRun(dir)).toBe(false);
    expect(heldRefusal(dir)).toBe(undefined);
  });

  test("pushBranch is refused while held and succeeds after release", async () => {
    const { work, remote } = repoWithRemote();
    const git = new Git(new GitCommandRunner());
    holdRun(work, "alice");
    const refused = await git.pushBranch(work, "factory/issue-7");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("a human holds this run");
    const none = Bun.spawnSync(["git", "branch", "--list", "factory/issue-7"], { timeout: 60_000, cwd: remote });
    expect(none.stdout.toString()).toBe("");
    releaseRun(work);
    const ok = await git.pushBranch(work, "factory/issue-7");
    expect(ok.code).toBe(0);
    const some = Bun.spawnSync(["git", "branch", "--list", "factory/issue-7"], { timeout: 60_000, cwd: remote });
    expect(some.stdout.toString()).toContain("factory/issue-7");
  });

  test("command text", () => {
    const home = tmp();
    const prev = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = home;
    try {
      expect(runHoldCommand("release", 9, "o/r", "x")).toBe("factory release: #9 was not held");
      expect(runHoldCommand("hold", 9, "o/r", "x")).toContain("#9 held");
      expect(runHoldCommand("release", 9, "o/r", "x")).toBe("factory release: #9 released");
    } finally {
      if (prev === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = prev;
    }
  });
});
