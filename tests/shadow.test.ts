// Shadow mode: triage and plan are posted as comments, and no claim, branch or PR is made.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import { mergeConfig } from "../src/config";
import { Git } from "../src/git";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { processReadyIssue } from "../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

mkdirSync(tmpdir(), { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "factory-shadow-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const dir = (p: string) => mkdtempSync(join(scratch, p));
const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdout: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });

class ShadowGit extends FakeGit {
  detached: string[] = [];
  removed: string[] = [];
  override async removeWorktree(_c: string, worktreeDir: string): Promise<void> {
    this.removed.push(worktreeDir);
  }
  override async ensureDetachedWorktree(_c: string, worktreeDir: string): Promise<void> {
    this.detached.push(worktreeDir);
    mkdirSync(worktreeDir, { recursive: true });
  }
}

describe("shadow mode", () => {
  async function shadowRun(verdict?: string) {
    const issue = baseIssue(1, [LABEL.ready]);
    const github = new FakeGitHub([issue]);
    const git = new ShadowGit();
    const state = new FactoryState(":memory:");
    const config = mergeConfig({
      repo: "acme/widgets",
      agents: { scripted: { command: [join(import.meta.dir, "fixtures/agents/fake-agent.sh")] } },
      stages: { default: "scripted" },
    });
    const deps = {
      ...{ github, git, state, executor: new CommandExecutor(config.agents, config.stages) },
      ...{ gateRunner: new FakeGateRunner(), holdoutRunner: new FakeHoldoutRunner(), cloneDir: dir("clone-") },
      workspacesDir: dir("ws-"),
      shadow: true,
    };
    const prev = process.env.FAKE_VERDICT;
    if (verdict) process.env.FAKE_VERDICT = verdict;
    const outcome = await processReadyIssue(issue, deps, config);
    if (prev === undefined) delete process.env.FAKE_VERDICT;
    else process.env.FAKE_VERDICT = prev;
    return { outcome, git, github, state };
  }

  test("a ready issue is planned, built and verified in a throwaway worktree, with no claim, push or PR", async () => {
    const { outcome, git, github, state } = await shadowRun();
    expect(outcome).toBe("waiting");
    expect(git.claims).toBe(0);
    expect(git.pushed).toEqual([]);
    expect(git.committed).toHaveLength(1);
    expect(git.detached).toHaveLength(1);
    expect(git.removed).toEqual(git.detached);
    expect(github.createdPrs).toEqual([]);
    const bodies = github.issues.get(1)!.comments.map((c) => c.body);
    expect(bodies.some((b) => b.includes("factory:plan"))).toBe(true);
    expect(bodies.some((b) => b.includes("factory:verdict"))).toBe(true);
    const summary = bodies.find((b) => b.includes("Shadow run"))!;
    expect(summary).toContain("triage, plan, build, verify");
    expect(summary).toContain("no branch, push or pull request");
    expect(github.issues.get(1)!.labels.map((l) => l.name)).not.toContain(LABEL.ready);
    state.close();
  });

  test("a reject verdict is posted and ends the run, still with nothing pushed", async () => {
    const reject = JSON.stringify({
      result: "reject",
      rounds: 1,
      findings: [{ severity: "must", confidence: 5, what: "drops a cent" }],
    });
    const { outcome, git, github, state } = await shadowRun(reject);
    expect(outcome).toBe("waiting");
    expect(git.pushed).toEqual([]);
    expect(git.committed).toHaveLength(1);
    const summary = github.issues
      .get(1)!
      .comments.map((c) => c.body)
      .find((b) => b.includes("Shadow run"))!;
    expect(summary).toContain("verify sent the build back");
    state.close();
  });

  test("a whole shadow run on a real clone leaves no branch locally or on the origin", async () => {
    const origin = dir("origin-");
    sh(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "a.txt"), "a");
    sh(origin, "add", "-A");
    sh(origin, "commit", "-qm", "init");
    const clone = dir("c-");
    Bun.spawnSync(["git", "clone", "-q", origin, clone], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    const heads = (cwd: string) => sh(cwd, "branch", "-a", "--format=%(refname)").stdout.toString();
    const before = [heads(clone), heads(origin)];
    const config = mergeConfig({
      repo: "acme/widgets",
      agents: { scripted: { command: [join(import.meta.dir, "fixtures/agents/fake-agent.sh")] } },
      stages: { default: "scripted" },
    });
    const issue = baseIssue(1, [LABEL.ready]);
    const state = new FactoryState(":memory:");
    const deps = {
      ...{ github: new FakeGitHub([issue]), git: new Git(), state, cloneDir: clone },
      ...{ executor: new CommandExecutor(config.agents, config.stages), gateRunner: new FakeGateRunner() },
      ...{ holdoutRunner: new FakeHoldoutRunner(), workspacesDir: dir("ws-"), shadow: true },
    };
    await processReadyIssue(issue, deps, config);
    expect(deps.github.issues.get(1)!.comments.some((c) => c.body.includes("Shadow run"))).toBe(true);
    expect([heads(clone), heads(origin)]).toEqual(before);
    state.close();
  });

  test("the real detached worktree adds no branch to the clone", async () => {
    const origin = dir("origin-");
    sh(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "a.txt"), "a");
    sh(origin, "add", "-A");
    sh(origin, "commit", "-qm", "init");
    const clone = dir("c-");
    Bun.spawnSync(["git", "clone", "-q", origin, clone], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    const before = sh(clone, "branch", "-a", "--format=%(refname)").stdout.toString();
    const wt = join(dir("w-"), "issue-7");
    await new Git().ensureDetachedWorktree(clone, wt, "main");
    expect(sh(wt, "rev-parse", "--abbrev-ref", "HEAD").stdout.toString().trim()).toBe("HEAD");
    expect(sh(clone, "branch", "-a", "--format=%(refname)").stdout.toString()).toBe(before);
    expect(sh(origin, "branch", "--format=%(refname)").stdout.toString().trim()).toBe("refs/heads/main");
  });
});
