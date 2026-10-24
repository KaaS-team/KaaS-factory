// Plan v2.7.0 item 7: a cap breached before a stage starts parks the issue
// with a "budget" inbox item, and the daily cap pauses new factory:ready
// pickups. Every case below proves the cap is checked directly: the fake
// executor throws if a stage ever actually runs, so a test can only pass by
// the cap catching the issue *before* any stage work, never by coincidence.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubSpend } from "../src/adapters/github-store/spend";
import { mergeConfig } from "../src/config";
import { buildInbox } from "../src/inbox";
import { MachineLeases, MachineSpend } from "../src/machine";
import { FactoryState } from "../src/state";
import { pollOnce, processReadyIssue } from "../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

class ThrowingExecutor {
  async runStage(): Promise<never> {
    throw new Error("a stage ran despite a breached spend cap");
  }
}

function setup(config: Parameters<typeof mergeConfig>[0]) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
  const github = new FakeGitHub([baseIssue(1, ["factory:ready"])]);
  const state = new FactoryState(":memory:");
  const deps = {
    github,
    git: new FakeGit(),
    state,
    executor: new ThrowingExecutor(),
    gateRunner: new FakeGateRunner(),
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir,
    workspacesDir,
  };
  const merged = mergeConfig({ repo: "acme/repo", concurrency: 1, ...config });
  return { deps, config: merged, github, state, workspacesDir, cloneDir };
}

function cleanup(ctx: { workspacesDir: string; cloneDir: string }): void {
  rmSync(ctx.workspacesDir, { recursive: true, force: true });
  rmSync(ctx.cloneDir, { recursive: true, force: true });
}

describe("checkSpendCap parks an issue before any stage runs", () => {
  test("an issue at or over its own perIssueUsd cap parks with a budget inbox item", async () => {
    const ctx = setup({ spend: { perIssueUsd: 5 } });
    ctx.state.recordStageRun({
      repo: "acme/repo",
      issue: 1,
      stage: "triage",
      agent: "claude",
      model: "claude-sonnet-5",
      started_at: "2020-01-01T00:00:00Z",
      finished_at: "2020-01-01T00:01:00Z",
      duration_ms: 60_000,
      tool_calls: 1,
      tokens_in: 1,
      tokens_out: 1,
      tokens_cached: 0,
      cost_usd: 5,
      usage_complete: 1,
      exit_code: 0,
      killed_reason: null,
    });

    const outcome = await processReadyIssue(ctx.github.issues.get(1)!, ctx.deps, ctx.config);

    expect(outcome).toBe("needs-human");
    const issue = ctx.github.issues.get(1)!;
    expect(issue.labels.map((l) => l.name)).toContain("factory:needs-human");
    expect(issue.comments.at(-1)?.body).toContain("perIssueUsd");
    expect(buildInbox([issue])[0]?.kind).toBe("budget");

    cleanup(ctx);
  });

  test("a repo at or over its dailyUsd cap parks a fresh issue the same way", async () => {
    const ctx = setup({ spend: { dailyUsd: 2 } });
    ctx.state.recordStageRun({
      repo: "acme/repo",
      issue: 99,
      stage: "build",
      agent: "claude",
      model: "claude-sonnet-5",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 1000,
      tool_calls: 1,
      tokens_in: 1,
      tokens_out: 1,
      tokens_cached: 0,
      cost_usd: 2,
      usage_complete: 1,
      exit_code: 0,
      killed_reason: null,
    });

    const outcome = await processReadyIssue(ctx.github.issues.get(1)!, ctx.deps, ctx.config);

    expect(outcome).toBe("needs-human");
    expect(ctx.github.issues.get(1)!.comments.at(-1)?.body).toContain("dailyUsd");

    cleanup(ctx);
  });

  test("an issue at or over its maxUnreportedRuns cap parks even though every run's own cost is unknown", async () => {
    const ctx = setup({ spend: { maxUnreportedRuns: 2 } });
    for (let i = 0; i < 2; i++) {
      ctx.state.recordStageRun({
        repo: "acme/repo",
        issue: 1,
        stage: "triage",
        agent: "claude",
        model: "claude-sonnet-5",
        started_at: "2020-01-01T00:00:00Z",
        finished_at: "2020-01-01T00:01:00Z",
        duration_ms: 60_000,
        tool_calls: 1,
        tokens_in: 1,
        tokens_out: 1,
        tokens_cached: 0,
        cost_usd: null,
        usage_complete: 0,
        exit_code: 0,
        killed_reason: null,
      });
    }

    const outcome = await processReadyIssue(ctx.github.issues.get(1)!, ctx.deps, ctx.config);

    expect(outcome).toBe("needs-human");
    expect(ctx.github.issues.get(1)!.comments.at(-1)?.body).toContain("maxUnreportedRuns");

    cleanup(ctx);
  });

  test("the machine's own dailyUsd cap parks a repo that never spent a cent itself, because another repo sharing the machine did", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "factory-machine-"));
    const dbPath = join(dbDir, "machine.db");
    const machineSpend = new MachineSpend(dbPath);
    machineSpend.record("acme/other-repo", 10); // a different repo, same machine

    const ctx = setup({});
    const deps = {
      ...ctx.deps,
      machine: { leases: new MachineLeases(":memory:"), config: { slots: 2, dailyUsd: 5 }, spend: machineSpend },
    };

    const outcome = await processReadyIssue(ctx.github.issues.get(1)!, deps, ctx.config);

    expect(outcome).toBe("needs-human");
    expect(ctx.github.issues.get(1)!.comments.at(-1)?.body).toContain("machine has spent");

    machineSpend.close();
    rmSync(dbDir, { recursive: true, force: true });
    cleanup(ctx);
  });
});

describe("pollOnce pauses new pickups while a daily spend cap is hit", () => {
  test("factory:ready issues are skipped, but an issue already parked keeps surfacing in the inbox buckets", async () => {
    const ctx = setup({ spend: { dailyUsd: 1 } });
    ctx.github.issues.set(2, baseIssue(2, ["factory:needs-human"]));
    ctx.state.recordStageRun({
      repo: "acme/repo",
      issue: 50,
      stage: "build",
      agent: "claude",
      model: "claude-sonnet-5",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 1000,
      tool_calls: 1,
      tokens_in: 1,
      tokens_out: 1,
      tokens_cached: 0,
      cost_usd: 1,
      usage_complete: 1,
      exit_code: 0,
      killed_reason: null,
    });

    const result = await pollOnce(ctx.deps, ctx.config);

    expect(result.paused).toBe(true);
    expect(result.reason).toContain("budget");
    expect(result.processed).not.toContain(1); // the ready pickup never started
    expect(ctx.github.issues.get(1)!.labels.map((l) => l.name)).toContain("factory:ready"); // untouched, still waiting

    cleanup(ctx);
  });
});

describe("with spend on GitHub, caps count every worker's spend", () => {
  const today = () => new Date().toISOString();

  test("another worker's spend on this issue parks it here, though this machine spent nothing", async () => {
    const ctx = setup({ spend: { perIssueUsd: 5 } });
    await new GitHubSpend(ctx.github, "acme/repo", "ci-job").record({
      issue: 1,
      stage: "build",
      costUsd: 6,
      tokensIn: 1,
      tokensOut: 1,
      at: today(),
    });
    const deps = { ...ctx.deps, spend: new GitHubSpend(ctx.github, "acme/repo", "laptop") };
    expect(await processReadyIssue(ctx.github.issues.get(1)!, deps, ctx.config)).toBe("needs-human");
    expect(ctx.github.issues.get(1)!.comments.at(-1)?.body).toContain("perIssueUsd");
    cleanup(ctx);
  });

  test("another worker's spend today pauses pickups here", async () => {
    const ctx = setup({ spend: { dailyUsd: 1 } });
    ctx.github.issues.set(50, baseIssue(50, []));
    await new GitHubSpend(ctx.github, "acme/repo", "cloud").record({
      issue: 50,
      stage: "build",
      costUsd: 1,
      tokensIn: 1,
      tokensOut: 1,
      at: today(),
    });
    const result = await pollOnce(
      { ...ctx.deps, spend: new GitHubSpend(ctx.github, "acme/repo", "laptop") },
      ctx.config,
    );
    expect(result.paused).toBe(true);
    expect(result.processed).not.toContain(1);
    cleanup(ctx);
  });

  test("a store that lost a write never reads below this machine's own spend", async () => {
    const ctx = setup({ spend: { perIssueUsd: 5 } });
    ctx.state.recordStageRun({
      repo: "acme/repo",
      issue: 1,
      stage: "triage",
      agent: "claude",
      model: "claude-sonnet-5",
      started_at: "2020-01-01T00:00:00Z",
      finished_at: "2020-01-01T00:01:00Z",
      duration_ms: 60_000,
      tool_calls: 1,
      tokens_in: 1,
      tokens_out: 1,
      tokens_cached: 0,
      cost_usd: 5,
      usage_complete: 1,
      exit_code: 0,
      killed_reason: null,
    });
    const deps = { ...ctx.deps, spend: new GitHubSpend(ctx.github, "acme/repo", "laptop") };
    expect(await processReadyIssue(ctx.github.issues.get(1)!, deps, ctx.config)).toBe("needs-human");
    cleanup(ctx);
  });

  test("a forged marker can only add: a negative cost is not data", async () => {
    const ctx = setup({ spend: { perIssueUsd: 5 } });
    const spend = new GitHubSpend(ctx.github, "acme/repo", "laptop");
    await spend.record({ issue: 1, stage: "build", costUsd: 6, tokensIn: 1, tokensOut: 1, at: today() });
    await ctx.github.commentIssue(
      "acme/repo",
      1,
      `<!-- factory:spend ${JSON.stringify({ holder: "x", costUsd: -100, unreportedRuns: 0, runs: 1 })} -->`,
    );
    expect((await spend.issue(1)).costUsd).toBe(6);
    cleanup(ctx);
  });
});
