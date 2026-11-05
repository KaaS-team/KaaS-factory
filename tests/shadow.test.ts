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
  override async ensureDetachedWorktree(_c: string, worktreeDir: string): Promise<void> {
    this.detached.push(worktreeDir);
    mkdirSync(worktreeDir, { recursive: true });
  }
}

describe("shadow mode", () => {
  test("a ready issue is planned and commented on, with no claim, push or PR", async () => {
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
    expect(await processReadyIssue(issue, deps, config)).toBe("waiting");
    expect(git.claims).toBe(0);
    expect(git.pushed).toEqual([]);
    expect(git.committed).toEqual([]);
    expect(git.detached).toHaveLength(1);
    expect(github.createdPrs).toEqual([]);
    const bodies = github.issues.get(1)!.comments.map((c) => c.body);
    expect(bodies.some((b) => b.includes("factory:plan"))).toBe(true);
    expect(bodies.some((b) => b.includes("Shadow run") && b.includes("No branch or pull request"))).toBe(true);
    expect(github.issues.get(1)!.labels.map((l) => l.name)).not.toContain(LABEL.ready);
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
