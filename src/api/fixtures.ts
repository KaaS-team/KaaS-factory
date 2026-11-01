// Seeded in-memory state for `factory serve --fixture` and the generated client's fake: two repos, three runs.

import type { Run, RunEvent, StageRun } from "../state";
import { tokenAuth } from "./auth";
import type { ApiState, CoreDeps } from "./core";
import { LiveFeed } from "./stream";

export const FIXTURE_TOKEN = "fixture-token";

function run(id: number, repo: string, issue: number, over: Partial<Run>): Run {
  return {
    id,
    issue,
    repo,
    title: `Issue ${issue}`,
    stage: "build",
    status: "running",
    started_at: "2026-10-30T10:00:00.000Z",
    updated_at: "2026-10-30T10:05:00.000Z",
    tool_calls: 12,
    tokens_in: 1000,
    tokens_out: 400,
    cost_usd: 0.25,
    gate_line: null,
    pr_url: null,
    reason: null,
    status_comment_id: null,
    config_hash: null,
    ...over,
  };
}

function event(id: number, runId: number, stage: Run["stage"], kind: string, text: string): RunEvent {
  return { id, run_id: runId, ts: `2026-10-30T10:0${id}:00.000Z`, stage, kind, text };
}

class FixtureState implements ApiState {
  constructor(
    private readonly runs: Run[],
    private readonly events: RunEvent[],
  ) {}
  listRuns(repo?: string): Run[] {
    return this.runs.filter((r) => !repo || r.repo === repo);
  }
  getRun(repo: string, issue: number): Run | undefined {
    return this.runs.find((r) => r.repo === repo && r.issue === issue);
  }
  listEvents(runId: number, opts?: { after?: number; limit?: number }): RunEvent[] {
    return this.events.filter((e) => e.run_id === runId && e.id > (opts?.after ?? 0)).slice(0, opts?.limit ?? 200);
  }
  listStageRuns(): StageRun[] {
    return [];
  }
  spendSummary(repo: string): { costUsd: number; unreportedRuns: number } {
    return { costUsd: this.listRuns(repo).reduce((sum, r) => sum + r.cost_usd, 0), unreportedRuns: 0 };
  }
}

export const FIXTURES = ["two-repos"] as const;

export function fixture(name: string, token = FIXTURE_TOKEN): CoreDeps {
  if (name !== "two-repos") throw new Error(`unknown fixture "${name}" (known: ${FIXTURES.join(", ")})`);
  const states: Record<string, ApiState> = {
    "acme/web": new FixtureState(
      [
        run(1, "acme/web", 7, { title: "Add dark mode", stage: "build", status: "running" }),
        run(2, "acme/web", 8, { title: "Fix login redirect", stage: "plan", status: "awaiting-approval" }),
      ],
      [event(1, 1, "build", "text", "writing the test first"), event(2, 1, "build", "tool", "bun test")],
    ),
    "acme/api": new FixtureState(
      [
        run(3, "acme/api", 21, {
          title: "Paginate /orders",
          stage: "pr",
          status: "shipped",
          pr_url: "https://github.com/acme/api/pull/22",
          gate_line: "make check: ok",
        }),
      ],
      [event(3, 3, "pr", "text", "opened the pull request")],
    ),
  };
  return {
    repos: () => Object.keys(states),
    state: (repo) => states[repo] ?? null,
    feed: new LiveFeed(),
    auth: tokenAuth({ FACTORY_API_TOKEN: token }),
  };
}
