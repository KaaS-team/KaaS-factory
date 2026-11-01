// The monthly page: merges, time to green, cost per verified change and the veto, revert and
// escaped-defect rates, with no denominator reading n/a rather than 0.

import { expect, test } from "bun:test";
import { metricsMarkdown, monthMetrics } from "../dashboard/metrics-month";
import { FactoryState, type StageRunInput } from "../src/state";

const REPO = "acme/widgets";

function attempt(issue: number, over: Partial<StageRunInput> = {}): StageRunInput {
  return {
    repo: REPO,
    issue,
    stage: "build",
    agent: "claude",
    model: "m",
    started_at: "2026-10-01T00:00:00Z",
    finished_at: "2026-10-01T01:00:00Z",
    duration_ms: 3_600_000,
    tool_calls: 1,
    tokens_in: 1,
    tokens_out: 1,
    tokens_cached: 0,
    cost_usd: 2,
    exit_code: 0,
    killed_reason: null,
    ...over,
  };
}

function merged(state: FactoryState, issue: number, time: string): void {
  state.recordBusEvent({
    id: `merged-${issue}`,
    direction: "out",
    type: "factory.pr.merged",
    source: "factory",
    subject: `${REPO}#${issue}`,
    time,
    data: JSON.stringify({ repo: REPO, issue, pr: 100 + issue, by: "factory" }),
    handled_at: null,
  });
}

function verify(state: FactoryState, issue: number, startedAt: string, verdict: string): void {
  state.recordStageRun(attempt(issue, { stage: "verify", started_at: startedAt, cost_usd: 1 }));
  state.setVerifyVerdict(REPO, issue, verdict);
}

// Issues 1 and 2 merge in October (4 and 6 hours after they start), issue 3 in September.
// Issue 2 has an attempt of unknown cost, so only issue 1's 5 dollars (2 build + 1 + 2 verify) count. Verify verdicts: 3 October (1 reject) plus a rejected
// September one that must be ignored; issue 1 gets a second October verdict.
function seeded(): FactoryState {
  const state = new FactoryState(":memory:");
  for (const [issue, start] of [
    [1, "2026-10-02T08:00:00Z"],
    [2, "2026-10-03T04:00:00Z"],
    [3, "2026-09-10T00:00:00Z"],
  ] as const) {
    state.upsertRun({ issue, repo: REPO, title: `Task ${issue}`, stage: "pr", status: "shipped" });
    state.write((db) => {
      db.query("UPDATE runs SET started_at = $t WHERE issue = $issue").run({ $t: start, $issue: issue });
    });
  }
  merged(state, 1, "2026-10-02T12:00:00Z");
  merged(state, 2, "2026-10-03T10:00:00Z");
  merged(state, 3, "2026-09-10T05:00:00Z");
  state.recordStageRun(attempt(1, { started_at: "2026-10-02T08:00:00Z" }));
  state.recordStageRun(attempt(2, { started_at: "2026-10-03T00:00:00Z", cost_usd: null, usage_complete: 0 }));
  state.recordStageRun(attempt(3, { started_at: "2026-09-10T00:00:00Z", cost_usd: 8 }));
  verify(state, 1, "2026-10-02T09:00:00Z", "reject");
  verify(state, 2, "2026-10-03T05:00:00Z", "pass");
  verify(state, 3, "2026-09-10T02:00:00Z", "reject");
  state.recordStageRun(attempt(1, { stage: "verify", started_at: "2026-10-02T11:00:00Z" }));
  state.setVerifyVerdict(REPO, 1, "pass");
  state.recordStageRun(attempt(2, { stage: "verify", started_at: "2026-10-03T08:00:00Z" }));
  state.setVerifyVerdict(REPO, 2, "pass");
  return state;
}

test("a month's merges, median, cost, veto, revert and escaped rates", () => {
  const m = monthMetrics([{ state: seeded(), repo: REPO }], "2026-10", { reverts: 1, escaped: 1 });
  expect(m).toEqual({
    month: "2026-10",
    merged: 2,
    medianCycleHours: 5,
    costPerVerifiedChange: 5,
    judgeVetoRate: 0.25,
    revertRate: 0.5,
    escapedDefectRate: 0.5,
  });
});

test("a month with no merges has null rates and the Markdown says n/a", () => {
  const m = monthMetrics([{ state: seeded(), repo: REPO }], "2026-08", { reverts: 0, escaped: 0 });
  expect(m).toEqual({
    month: "2026-08",
    merged: 0,
    medianCycleHours: null,
    costPerVerifiedChange: null,
    judgeVetoRate: null,
    revertRate: null,
    escapedDefectRate: null,
  });
  const md = metricsMarkdown(m);
  expect(md).toContain("# Factory metrics, 2026-08");
  expect(md).toContain("| Revert rate | n/a |");
  expect(md).toContain("| Merged changes | 0 |");
});
