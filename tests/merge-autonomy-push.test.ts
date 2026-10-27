// The autonomous merge's pushes skip pre-push hooks, and a refused rebase push is quoted in a comment.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../src/config";
import { GitRefused, type MergeContext, rebaseOnBase, settleMerge } from "../src/merge-autonomy";
import type { MergeDecision } from "../src/merge-policy";

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

async function clone(root: string, name: string, remote: string): Promise<string> {
  const dir = join(root, name);
  await git(root, "clone", "-q", remote, dir);
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

async function commit(dir: string, file: string, text: string, message: string): Promise<void> {
  writeFileSync(join(dir, file), text);
  await git(dir, "add", file);
  await git(dir, "commit", "-q", "-m", message);
}

// A remote with main, and a PR branch "feature" cut before main moved on, so a rebase changes its head.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "merge-autonomy-push-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = await clone(root, "seed", remote);
  await commit(seed, "a.txt", "a\n", "base");
  await git(seed, "push", "-q", "origin", "HEAD:main");
  const work = await clone(root, "work", remote);
  await git(work, "checkout", "-q", "-b", "feature");
  await commit(work, "f.txt", "feature\n", "feature");
  await git(work, "push", "-q", "origin", "feature");
  await commit(seed, "b.txt", "b\n", "main moves on");
  await git(seed, "push", "-q", "origin", "HEAD:main");
  return { root, remote, seed, work };
}

const config = { repo: "o/r", base: "main", merge: {} } as unknown as FactoryConfig;
const auto = { mode: "full", merge: config.merge } as unknown as MergeContext;
const decision: MergeDecision = { outcome: "merge", headSha: "unused" };

function deps(rebase?: () => Promise<string>) {
  return {
    github: { mergePr: async () => {}, createPr: async () => 0 } as never,
    state: { getSetting: () => null, setSetting: () => {} } as never,
    lease: { acquire: () => true, release: () => {} },
    rebase,
  };
}

test("rebaseOnBase pushes past a failing pre-push hook", async () => {
  const { remote, work } = await fixture();
  const hook = join(work, ".git", "hooks", "pre-push");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const head = await rebaseOnBase(work, "main", "feature");
  expect(await git(remote, "rev-parse", "refs/heads/feature")).toBe(head);
});

test("every push argv in merge-autonomy.ts carries --no-verify", () => {
  const src = readFileSync(join(import.meta.dir, "../src/merge-autonomy.ts"), "utf8");
  const pushes = src.split("\n").filter((line) => line.includes('"push",'));
  expect(pushes).toHaveLength(2);
  for (const line of pushes) expect(line).toContain('"--no-verify"');
});

test("a lease failure posts the stderr tail once", async () => {
  const { root, remote, work } = await fixture();
  const other = await clone(root, "other", remote);
  await git(other, "checkout", "-q", "feature");
  await commit(other, "g.txt", "moved\n", "someone else pushes");
  await git(other, "push", "-q", "origin", "feature");
  const posts: string[] = [];
  const run = { worktree: work, pr: 1, branch: "feature", issue: 1, post: async (b: string) => void posts.push(b) };
  await expect(settleMerge(deps(), config, auto, decision, run)).rejects.toThrow(/stale info/);
  const refusals = posts.filter((b) => b.includes("Merge not attempted"));
  expect(refusals).toHaveLength(1);
  expect(refusals[0]).toContain("stale info");
});

test("a 25-line push refusal shows its last 20 lines", async () => {
  const stderr = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
  const posts: string[] = [];
  const run = { worktree: "", pr: 1, branch: "feature", issue: 1, post: async (b: string) => void posts.push(b) };
  const rebase = async () => {
    throw new GitRefused("push", stderr);
  };
  await expect(settleMerge(deps(rebase), config, auto, decision, run)).rejects.toThrow(/line 25/);
  const lines = posts.find((b) => b.includes("Merge not attempted"))!.split("\n");
  expect(lines).toContain("line 6");
  expect(lines).toContain("line 25");
  expect(lines).not.toContain("line 5");
});

test("a refused push with no run.post rethrows and posts nothing", async () => {
  const rebase = async () => {
    throw new GitRefused("push", "stale info");
  };
  const run = { worktree: "", pr: 1, branch: "feature", issue: 1 };
  await expect(settleMerge(deps(rebase), config, auto, decision, run)).rejects.toThrow(/stale info/);
});

test("a rebase conflict posts no push comment", async () => {
  const { seed, work } = await fixture();
  await commit(seed, "f.txt", "main side\n", "main also adds f");
  await git(seed, "push", "-q", "origin", "HEAD:main");
  await commit(work, "f.txt", "feature side\n", "feature adds f");
  const posts: string[] = [];
  const run = { worktree: work, pr: 1, branch: "feature", issue: 1, post: async (b: string) => void posts.push(b) };
  await expect(settleMerge(deps(), config, auto, decision, run)).rejects.toThrow(/git rebase/);
  expect(posts.filter((b) => b.includes("Merge not attempted"))).toHaveLength(0);
});
