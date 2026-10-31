// merge.method and merge.queue: the gh argv per method, host mode never rebasing, and the doctor row.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../src/config";
import { mergeProblems } from "../src/config-merge";
import { type CommandResult, GitHub } from "../src/github";
import { type MergeSettings, mergeMethodCheck } from "../src/merge-method";
import { type MergeContext, settleMerge } from "../src/merge-autonomy";

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

async function mergeArgvFor(settings?: MergeSettings): Promise<string[]> {
  const seen: string[][] = [];
  const gh = new GitHub({
    run: async (args) => {
      seen.push(args);
      return { stdout: "", stderr: "", code: 0 };
    },
  });
  await gh.mergePr("o/r", 7, "abc123", settings);
  return seen[0]!;
}

describe("gh pr merge argv", () => {
  const base = (flags: string[]) => ["pr", "merge", "7", "--repo", "o/r", ...flags, "--match-head-commit", "abc123"];
  test("no settings is today's squash", async () => {
    expect(await mergeArgvFor()).toEqual(base(["--squash"]));
  });
  test("each method merges as configured", async () => {
    expect(await mergeArgvFor({ method: "squash" })).toEqual(base(["--squash"]));
    expect(await mergeArgvFor({ method: "rebase" })).toEqual(base(["--rebase"]));
    expect(await mergeArgvFor({ method: "merge" })).toEqual(base(["--merge"]));
  });
  test("host method only enables auto-merge", async () => {
    expect(await mergeArgvFor({ method: "host" })).toEqual(base(["--auto"]));
  });
  test("host queue keeps the method and adds auto-merge", async () => {
    expect(await mergeArgvFor({ method: "rebase", queue: "host" })).toEqual(base(["--auto", "--rebase"]));
  });
});

describe("config validation", () => {
  test("rejects unknown values", () => {
    expect(mergeProblems({ method: "fast-forward" })).toEqual([
      'merge.method: expected "squash", "rebase", "merge" or "host", got "fast-forward"',
    ]);
    expect(mergeProblems({ queue: "bors" })).toEqual(['merge.queue: expected "factory", "host" or "none", got "bors"']);
    expect(mergeProblems({ method: "host", queue: "none" })).toEqual([]);
  });
});

describe("host mode never rebases or force-pushes", () => {
  async function fixture() {
    mkdirSync(tmpdir(), { recursive: true });
    const root = mkdtempSync(join(tmpdir(), "merge-method-"));
    roots.push(root);
    const remote = join(root, "remote.git");
    await git(root, "init", "-q", "--bare", "-b", "main", remote);
    const mk = async (name: string) => {
      const dir = join(root, name);
      await git(root, "clone", "-q", remote, dir);
      for (const [k, v] of [
        ["user.email", "t@example.com"],
        ["user.name", "t"],
        ["commit.gpgsign", "false"],
      ])
        await git(dir, "config", k!, v!);
      return dir;
    };
    const commit = async (dir: string, file: string) => {
      writeFileSync(join(dir, file), file);
      await git(dir, "add", file);
      await git(dir, "commit", "-q", "-m", file);
    };
    const seed = await mk("seed");
    await commit(seed, "a.txt");
    await git(seed, "push", "-q", "origin", "HEAD:main");
    const work = await mk("work");
    await git(work, "checkout", "-q", "-b", "feature");
    await commit(work, "f.txt");
    await git(work, "push", "-q", "origin", "feature");
    await commit(seed, "b.txt");
    await git(seed, "push", "-q", "origin", "HEAD:main");
    return { remote, work };
  }

  async function settle(merge: MergeSettings) {
    const { remote, work } = await fixture();
    const before = await git(remote, "rev-parse", "refs/heads/feature");
    const calls: unknown[][] = [];
    const config = { repo: "o/r", base: "main", merge } as unknown as FactoryConfig;
    const auto = { mode: "full", merge } as unknown as MergeContext;
    const deps = {
      github: { mergePr: async (...a: unknown[]) => void calls.push(a), createPr: async () => 0 } as never,
      state: { getSetting: () => null, setSetting: () => {} } as never,
      lease: { acquire: () => true, release: () => {} },
    };
    const run = { worktree: work, pr: 7, branch: "feature", issue: 1 };
    const merged = await settleMerge(deps, config, auto, { outcome: "merge", headSha: before }, run);
    return { merged, calls, before, after: await git(remote, "rev-parse", "refs/heads/feature") };
  }

  test("host method merges the unrebased head", async () => {
    const r = await settle({ method: "host" });
    expect(r.merged).toBe(true);
    expect(r.after).toBe(r.before);
    expect(r.calls).toEqual([["o/r", 7, r.before, { method: "host" }]]);
  });
  test("host queue merges the unrebased head", async () => {
    const r = await settle({ queue: "host" });
    expect(r.merged).toBe(true);
    expect(r.after).toBe(r.before);
  });
  test("default still rebases first, so the head moves and nothing merges", async () => {
    const r = await settle({});
    expect(r.merged).toBe(false);
    expect(r.after).not.toBe(r.before);
    expect(r.calls).toEqual([]);
  });
});

describe("doctor", () => {
  const runner = (info: object, code = 0) => ({
    run: async (): Promise<CommandResult> => ({ stdout: JSON.stringify(info), stderr: "", code }),
  });
  test("flags a method the repo disallows", async () => {
    const c = await mergeMethodCheck(
      { repo: "o/r", merge: { method: "rebase" } },
      runner({ allow_rebase_merge: false }),
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toBe('merge.method "rebase" but o/r has allow_rebase_merge off');
  });
  test("flags host mode without auto-merge", async () => {
    const c = await mergeMethodCheck({ repo: "o/r", merge: { method: "host" } }, runner({ allow_auto_merge: false }));
    expect(c.ok).toBe(false);
  });
  test("passes an allowed method, and defaults to squash", async () => {
    const info = { allow_squash_merge: true, allow_rebase_merge: false };
    expect((await mergeMethodCheck({ repo: "o/r", merge: {} }, runner(info))).ok).toBe(true);
    expect((await mergeMethodCheck({ repo: "o/r", merge: { method: "rebase" } }, runner(info))).ok).toBe(false);
  });
  test("an unreadable repo is a warning, not a failure", async () => {
    const c = await mergeMethodCheck({ repo: "o/r", merge: {} }, runner({}, 1));
    expect(c.warn).toBe(true);
  });
});
