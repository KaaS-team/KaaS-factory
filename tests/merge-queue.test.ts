// spec 10 merge-serial: one PR lands at a time, rebased onto the latest main and re-gated there.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecution } from "../src/adapters/local/execution";
import { ShellGateRunner } from "../src/gates";
import { Git } from "../src/git";
import { gitLandPort, land, type LandPort, MergeQueue } from "../src/merge-queue";

// Real git repos on a loaded machine take seconds, past bun's 5s default.
setDefaultTimeout(30_000);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const GREEN = "FACTORY_GATES: status=GREEN passed=1 failed=0 skipped=0 failed_gates=-";
const RED = "FACTORY_GATES: status=RED passed=0 failed=1 skipped=0 failed_gates=pair";

function fakePort(bases: string[], gate = GREEN) {
  const calls = { rebased: [] as string[], merged: [] as string[], pushed: [] as string[], reports: [] as string[] };
  let at = 0;
  const port: LandPort = {
    fetchBase: async () => bases[Math.min(at++, bases.length - 1)]!,
    rebase: async (onto) => {
      calls.rebased.push(onto);
      return { ok: true, head: `head-on-${onto}` };
    },
    gate: async () => ({
      status: gate.includes("GREEN") ? "GREEN" : "RED",
      passed: 0,
      failed: 0,
      skipped: 0,
      failedGates: [],
      raw: gate,
    }),
    push: async (head) => {
      calls.pushed.push(head);
      return { ok: true, detail: "" };
    },
    merge: async (head) => {
      calls.merged.push(head);
    },
    report: async (text) => {
      calls.reports.push(text);
    },
  };
  return { port, calls };
}

describe("land", () => {
  test("main moving between the gate and the merge sends the PR round again, onto the new main", async () => {
    const { port, calls } = fakePort(["m1", "m2", "m2", "m2"]);
    const result = await land(port, "pr-head");
    expect(result).toEqual({ outcome: "merged", head: "head-on-m2", base: "m2" });
    expect(calls.rebased).toEqual(["m1", "m2"]);
    expect(calls.merged).toEqual(["head-on-m2"]);
  });

  test("a gate that goes red after the rebase is not merged, and the PR is told why", async () => {
    const { port, calls } = fakePort(["m1"], RED);
    const result = await land(port, "pr-head");
    expect(result.outcome).toBe("refused");
    expect(calls.merged).toEqual([]);
    expect(calls.pushed).toEqual([]);
    expect(calls.reports[0]).toContain("factory:merge-queue:pr-head:m1");
    expect(calls.reports[0]).toContain("RED");
  });

  test("a rebase conflict is not merged", async () => {
    const { port, calls } = fakePort(["m1"]);
    const result = await land({ ...port, rebase: async () => ({ ok: false, detail: "CONFLICT a.txt" }) }, "pr-head");
    expect(result).toMatchObject({ outcome: "refused", reason: "conflict" });
    expect(calls.merged).toEqual([]);
  });

  test("main that never holds still is refused after the last round, never merged stale", async () => {
    const { port, calls } = fakePort(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
    const result = await land(port, "pr-head", 3);
    expect(result).toMatchObject({ outcome: "refused", reason: "main-moved" });
    expect(calls.merged).toEqual([]);
  });
});

describe("MergeQueue", () => {
  test("lands one PR at a time, even when one before it throws", async () => {
    const queue = new MergeQueue();
    let active = 0;
    let most = 0;
    const order: number[] = [];
    const job =
      (n: number, fail = false) =>
      async () => {
        active++;
        most = Math.max(most, active);
        await Bun.sleep(10);
        order.push(n);
        active--;
        if (fail) throw new Error("boom");
        return n;
      };
    const runs = [queue.run(job(1)), queue.run(job(2, true)), queue.run(job(3))];
    const settled = await Promise.allSettled(runs);
    expect(most).toBe(1);
    expect(order).toEqual([1, 2, 3]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

// Real git: two PRs, each green alone against the main it branched from.
const ENV_KEYS = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...ENV_KEYS },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// gates.sh goes red only when a.txt and b.txt are both present: a break neither PR shows alone.
const GATES = `if [ -e a.txt ] && [ -e b.txt ]; then echo "${RED}"; else echo "${GREEN}"; fi\n`;

function repo() {
  const root = mkdtempSync(join(tmpdir(), "factory-merge-queue-"));
  dirs.push(root);
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "clone");
  const clone = join(root, "clone");
  mkdirSync(join(clone, ".factory"));
  writeFileSync(join(clone, ".factory/gates.sh"), GATES);
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "base");
  git(clone, "push", "-q", "origin", "HEAD:main");
  const branch = (n: number, file: string) => {
    const wt = join(root, `wt-${n}`);
    git(clone, "worktree", "add", "-q", "-b", `factory/issue-${n}`, wt, "origin/main");
    writeFileSync(join(wt, file), `${file}\n`);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", `add ${file}`);
    git(wt, "push", "-q", "origin", `HEAD:refs/heads/factory/issue-${n}`);
    return { wt, head: git(wt, "rev-parse", "HEAD"), branch: `factory/issue-${n}` };
  };
  const lander = (pr: { wt: string; branch: string }, reports: string[]) => ({
    git: new Git(),
    gateRunner: new ShellGateRunner(new LocalExecution()),
    worktree: pr.wt,
    base: "main",
    branch: pr.branch,
    merge: async (head: string) => {
      git(pr.wt, "push", "-q", "origin", `${head}:refs/heads/main`);
    },
    report: async (text: string) => {
      reports.push(text);
    },
  });
  const onMain = (file: string) => git(clone, "ls-tree", "--name-only", "origin/main", file) !== "";
  const fetch = () => git(clone, "fetch", "-q", "origin");
  return { branch, lander, onMain, fetch, origin: join(root, "origin.git") };
}

describe("land on a real repo", () => {
  test("a PR whose rebase onto the latest main breaks the gate is not merged", async () => {
    const r = repo();
    const a = r.branch(1, "a.txt");
    const b = r.branch(2, "b.txt");
    const reports: string[] = [];
    expect(await land(gitLandPort(r.lander(a, reports), a.head), a.head)).toMatchObject({ outcome: "merged" });
    const second = await land(gitLandPort(r.lander(b, reports), b.head), b.head);
    expect(second).toMatchObject({ outcome: "refused", reason: "gate" });
    r.fetch();
    expect(r.onMain("a.txt")).toBe(true);
    expect(r.onMain("b.txt")).toBe(false);
    // The PR branch is left where the agent pushed it; the red rebase is never pushed.
    expect(git(r.origin, "rev-parse", "refs/heads/factory/issue-2")).toBe(b.head);
    expect(reports.join("\n")).toContain("not merged");
  });

  test("a PR behind main is rebased, pushed with a lease and merged on top of it", async () => {
    const r = repo();
    const a = r.branch(1, "a.txt");
    const c = r.branch(3, "c.txt");
    expect(await land(gitLandPort(r.lander(a, []), a.head), a.head)).toMatchObject({ outcome: "merged" });
    const result = await land(gitLandPort(r.lander(c, []), c.head), c.head);
    expect(result.outcome).toBe("merged");
    r.fetch();
    expect(r.onMain("a.txt")).toBe(true);
    expect(r.onMain("c.txt")).toBe(true);
    const pushed = git(r.origin, "rev-parse", "refs/heads/factory/issue-3");
    expect(pushed).not.toBe(c.head);
    expect(git(r.origin, "rev-parse", "refs/heads/main")).toBe(pushed);
  });
});
