// SPDX-License-Identifier: LicenseRef-KaaS-EE
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../../src/config";
import { spendCapHit, type WatchDeps } from "../../src/engine/common";
import { FactoryState } from "../../src/state";
import { processReadyIssue } from "../../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "../../tests/harness";
import { FleetSpendPolicy, fleetSpendConfigProblems } from "../spend/fleet-policy";

class ThrowingExecutor {
  async runStage(): Promise<never> {
    throw new Error("a stage ran despite a breached spend policy");
  }
}

function spent(state: FactoryState, repo: string, costUsd: number) {
  const now = new Date().toISOString();
  state.recordStageRun({
    repo,
    issue: 99,
    stage: "build",
    agent: "claude",
    model: "m",
    started_at: now,
    finished_at: now,
    duration_ms: 1000,
    tool_calls: 1,
    tokens_in: 1,
    tokens_out: 1,
    tokens_cached: 0,
    cost_usd: costUsd,
    usage_complete: 1,
    exit_code: 0,
    killed_reason: null,
  });
}

describe("fleet-wide spend policy", () => {
  test("an org's repos together, and the whole fleet, hold back work no single repo cap would", async () => {
    const state = new FactoryState(":memory:");
    const policy = new FleetSpendPolicy(
      { dailyUsd: 10, repos: ["acme/solo"], orgs: { red: { dailyUsd: 3, repos: ["acme/repo", "acme/other"] } } },
      (repo, since) => state.spendSummary(repo, since).costUsd,
    );
    const dir = mkdtempSync(join(tmpdir(), "factory-ee-spend-"));
    const github = new FakeGitHub([baseIssue(1, ["factory:ready"])]);
    const deps = {
      github,
      git: new FakeGit(),
      state,
      executor: new ThrowingExecutor(),
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      cloneDir: dir,
      workspacesDir: dir,
      spendPolicy: policy,
    } as unknown as WatchDeps;
    // Each repo is under its own $2 cap; together the org is at its $3.
    const config = mergeConfig({ repo: "acme/repo", concurrency: 1, spend: { dailyUsd: 2 } });
    spent(state, "acme/repo", 1.5);
    expect(await spendCapHit(deps, config)).toBeUndefined();
    spent(state, "acme/other", 1.5);

    expect(await spendCapHit(deps, config)).toContain("org red has spent $3.00");
    expect(await processReadyIssue(github.issues.get(1)!, deps, config)).toBe("needs-human");
    expect(github.issues.get(1)!.comments.at(-1)?.body).toContain("org red");

    // acme/solo is in no org, but the fleet cap counts every repo the policy names.
    const solo = mergeConfig({ repo: "acme/solo" });
    expect(await spendCapHit(deps, solo)).toBeUndefined();
    spent(state, "acme/solo", 7);
    expect(await spendCapHit(deps, solo)).toContain("the fleet has spent $10.00");
    expect(await spendCapHit(deps, mergeConfig({ repo: "acme/elsewhere" }))).toBeUndefined();

    expect(fleetSpendConfigProblems({ orgs: { red: { dailyUsd: -1, repos: ["nope"] } } })).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
