// delivery.stack "task" through the pr step: open one PR per task, retarget after a lower merge, carry a
// fix on a lower slice up the stack, and park naming the slice and file when a rebase conflicts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { configProblems, mergeConfig } from "../src/config";
import { cutSlices, deliverStack, stackOf } from "../src/engine/stack-pr";
import { parseWorkflowText } from "../src/engine/workflows";
import { git } from "../src/stacked-prs";
import { engine, removeEngineDirs } from "./engine-harness";
import { LABEL } from "../src/labels";
import { baseIssue, FakeGit, FakeGitHub } from "./harness";

const roots: string[] = [];
afterAll(() => {
  removeEngineDirs();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tasks = [
  { id: "t1", title: "Add a", files: ["a.txt"] },
  { id: "t2", title: "Add b", files: ["b.txt"] },
  { id: "t3", title: "Add c", files: ["c.txt"] },
];
const WORKFLOW = `---
name: ship
stages:
  triage: {}
  plan: {}
  build:
    needs: plan
  verify:
    needs: build
  pr:
    needs: verify
---
`;
const BRANCH = "factory/issue-1";

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`);
  return r.out;
}

async function put(dir: string, file: string, text: string, msg: string): Promise<void> {
  writeFileSync(join(dir, file), text);
  await sh(dir, "add", "-A");
  await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
}

// A work repo with a bare origin holding main, as ensureWorktree would hand the run.
async function repo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const origin = `${dir}.git`;
  await sh(tmpdir(), "init", "-q", "--bare", "-b", "main", origin);
  await sh(dir, "init", "-q", "-b", "main");
  await sh(dir, "config", "user.name", "t");
  await sh(dir, "config", "user.email", "t@t");
  await sh(dir, "remote", "add", "origin", origin);
  await put(dir, "README", "base\n", "base");
  await sh(dir, "push", "-q", "origin", "main");
  await sh(dir, "checkout", "-q", "-b", BRANCH);
}

class RealGit extends FakeGit {
  dir = "";
  override async ensureWorktree(_clone: string, worktreeDir: string, issue: number): Promise<void> {
    this.dir = worktreeDir;
    await repo(worktreeDir);
    await super.ensureWorktree(_clone, worktreeDir, issue);
  }
  override async commitPaths(dir: string, paths: readonly string[], message: string): Promise<boolean> {
    for (const p of paths) await put(dir, p, `${p}\n`, message);
    return true;
  }
  override async commitAll(dir: string, message: string): Promise<boolean> {
    await put(dir, "c.txt", "c.txt\n", message);
    return true;
  }
  override async push(dir: string): Promise<{ stdout: string; stderr: string; code: number }> {
    await sh(dir, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
    return { stdout: "", stderr: "", code: 0 };
  }
}

class StackGitHub extends FakeGitHub {
  retargets: [number, string][] = [];
  async retargetPr(_repo: string, n: number, base: string): Promise<void> {
    this.retargets.push([n, base]);
  }
}

const planJson = { risk: "low", revision: 1, files: ["a.txt"], autoApproveEligible: true };
const planOut = { "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan", "plan.json": JSON.stringify(planJson) };
// Tasks reach plan.json only when the plan was imported from the issue, so the build output carries them in.
const buildOut = {
  "status-comment.md": "<!-- factory:status v1 -->\nb",
  "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
  "plan.json": JSON.stringify({ ...planJson, tasks }),
};

async function run(stack: "epic" | "task") {
  const parsed = parseWorkflowText(WORKFLOW);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  mkdirSync(tmpdir(), { recursive: true });
  const git2 = new RealGit();
  const github = new StackGitHub([baseIssue(1, [LABEL.ready])]);
  const e = engine(
    parsed.workflow,
    0,
    {},
    {},
    { git: git2, github: github as never },
    { config: { delivery: { stack } }, outputs: { plan: [planOut], build: [buildOut] } },
  );
  return { e, github, git: git2, outcome: await e.run() };
}

describe("delivery.stack config", () => {
  test("defaults to epic and refuses an unknown value", () => {
    expect(mergeConfig({ repo: "a/b" }).delivery.stack).toBe("epic");
    expect(configProblems({ delivery: { stack: "task" } })).toEqual([]);
    expect(configProblems({ delivery: { stack: "tasks" } }).join("\n")).toContain("delivery.stack");
  });
});

describe("pr step with delivery.stack", () => {
  test("task mode opens one draft PR per slice, each based on the one before", async () => {
    const { github, outcome } = await run("task");
    expect(outcome).toBe("shipped");
    const prs = github.createdPrs.map((p) => [p.head, p.base, p.draft]);
    expect(prs).toEqual([
      [`${BRANCH}-t1`, "main", true],
      [`${BRANCH}-t2`, `${BRANCH}-t1`, true],
      [`${BRANCH}-t3`, `${BRANCH}-t2`, true],
    ]);
    // Only the top slice may close the issue; a lower merge must leave it open.
    expect(github.createdPrs[0]!.body).not.toContain("Closes #1");
    expect(github.createdPrs[2]!.body).toContain("Closes #1");
    expect(github.readyCalls.map((c) => c[0])).toEqual([`${BRANCH}-t1`, `${BRANCH}-t2`, `${BRANCH}-t3`]);
  });

  test("epic mode, the default, opens the one PR on the issue branch", async () => {
    const { github, outcome } = await run("epic");
    expect(outcome).toBe("shipped");
    expect(github.createdPrs.map((p) => p.head)).toEqual([BRANCH]);
  });
});

// The reconcile paths need the stack open first, so they start from the state the pr step leaves.
async function opened() {
  const { e, github, git: g } = await run("task");
  const plan = stackOf(e.config, BRANCH, tasks)!;
  const stackRun = {
    deps: e.deps,
    config: e.config,
    issueNumber: 1,
    label: "factory:building",
    worktree: g.dir,
    plan,
    tasks,
    type: "feat",
    finalBody: "Closes #1",
  };
  const origin = `${g.dir}.git`;
  return { e, github, plan, stackRun, dir: g.dir, origin };
}

const mergeBottom = async (github: StackGitHub, branch: string) => {
  const pr = github.prs.find((p) => p.headRefName === branch)!;
  (pr as { state: string }).state = "merged";
};

describe("a lower slice merges", () => {
  test("the next slice is rebased onto main and its PR base moves to main", async () => {
    const { github, stackRun, dir, plan } = await opened();
    // Squash merge: main gets t1's change as a new commit, so t2 still carries the old one.
    await sh(dir, "checkout", "-q", "main");
    await put(dir, "a.txt", "a.txt\n", "squash t1");
    await sh(dir, "push", "-q", "origin", "main");
    await sh(dir, "checkout", "-q", BRANCH);
    await mergeBottom(github, plan[0]!.branch);
    const before = github.createdPrs.length;

    const out = await deliverStack(stackRun);

    expect("parked" in out).toBe(false);
    const t2 = github.prs.find((p) => p.headRefName === plan[1]!.branch)!;
    expect(github.retargets).toEqual([[t2.number, "main"]]);
    expect(github.createdPrs.length).toBe(before);
    expect((await sh(dir, "log", "--format=%s", `origin/main..${plan[1]!.branch}`)).split("\n").length).toBe(1);
    expect((await sh(dir, "log", "--format=%s", `origin/main..${plan[2]!.branch}`)).split("\n").length).toBe(2);
  });

  test("a conflict in the middle of the stack parks naming the slice and the file", async () => {
    const { e, github, stackRun, dir, plan } = await opened();
    await sh(dir, "checkout", "-q", "main");
    await put(dir, "a.txt", "a.txt\n", "squash t1");
    await put(dir, "b.txt", "main wrote b differently\n", "clash with t2");
    await sh(dir, "push", "-q", "origin", "main");
    await sh(dir, "checkout", "-q", BRANCH);
    await mergeBottom(github, plan[0]!.branch);

    const out = await deliverStack(stackRun);

    expect(out).toEqual({ parked: "needs-human" });
    const note = github.issues.get(1)!.comments.at(-1)!.body;
    expect(note).toContain("t2");
    expect(note).toContain("b.txt");
    expect(github.retargets).toEqual([]);
    expect(e.config.delivery.stack).toBe("task");
  });
});

describe("a change on a lower slice", () => {
  test("is pushed and carried up through every slice above it", async () => {
    const { github, stackRun, dir, plan, origin } = await opened();
    await sh(dir, "checkout", "-q", plan[0]!.branch);
    await put(dir, "fix.txt", "review fix\n", "fix on t1");
    await sh(dir, "checkout", "-q", BRANCH);

    const out = await deliverStack(stackRun);

    expect("parked" in out).toBe(false);
    for (const slice of plan.slice(1)) expect(await sh(origin, "show", `${slice.branch}:fix.txt`)).toBe("review fix");
    expect(github.retargets).toEqual([]);
  });

  test("parks naming the conflict when a slice above cannot take it", async () => {
    const { github, stackRun, dir, plan } = await opened();
    await sh(dir, "checkout", "-q", plan[0]!.branch);
    await put(dir, "b.txt", "t1 wrote b first\n", "fix on t1 clashes with t2");
    await sh(dir, "checkout", "-q", BRANCH);

    const out = await deliverStack(stackRun);

    expect(out).toEqual({ parked: "needs-human" });
    const note = github.issues.get(1)!.comments.at(-1)!.body;
    expect(note).toContain("t2");
    expect(note).toContain("b.txt");
  });
});

describe("cutSlices", () => {
  test("leaves the run unsliced when the commits do not match the tasks", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "stack-cut-"));
    roots.push(dir, `${dir}.git`);
    await repo(dir);
    await put(dir, "a.txt", "a\n", "only one");
    const plan = stackOf(mergeConfig({ repo: "a/b", delivery: { stack: "task" } }), BRANCH, tasks)!;
    expect(await cutSlices(dir, "main", plan)).toBe(false);
    expect((await git(dir, "rev-parse", "--verify", "-q", `refs/heads/${plan[0]!.branch}`)).code).not.toBe(0);
  });
});
