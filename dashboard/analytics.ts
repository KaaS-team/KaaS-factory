// What the Analytics view shows, computed from stage_runs and runs. The
// server sends numbers; the page only draws them.

import { costFor } from "../src/pricing";
import type { Run, StageRun } from "../src/state";

export interface Bucket {
  readonly key: string;
  readonly attempts: number;
  readonly failures: number;
  readonly costUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly avgDurationMs: number;
}

export interface Analytics {
  readonly runs: number;
  readonly shipped: number;
  // shipped / finished runs (shipped, failed, rejected, cancelled, needs-human); null before any finish.
  readonly successRate: number | null;
  readonly spend7dUsd: number;
  readonly spend30dUsd: number;
  readonly byStage: readonly Bucket[];
  readonly byAgent: readonly Bucket[];
  readonly byModel: readonly Bucket[];
  readonly savings: Savings;
  readonly week: Week;
}

// The inbox brief's last seven days: runs that started, and runs that ended shipped or failed,
// by their last update. A run still going is counted as started only.
export interface Week {
  readonly started: number;
  readonly shipped: number;
  readonly failed: number;
}

// What model routing saved: each run's cost against the same tokens at its agent's strongest
// model, at list price. A run with no full count, no price or no baseline is counted, not guessed.
export interface Savings {
  readonly runs: number;
  readonly unpriced: number;
  readonly actualUsd: number;
  readonly baselineUsd: number;
  readonly savedUsd: number;
}

const FINISHED = new Set(["shipped", "failed", "rejected", "cancelled", "needs-human"]);
const DAY_MS = 86_400_000;

function bucketBy(rows: readonly StageRun[], key: (r: StageRun) => string): Bucket[] {
  const groups = new Map<string, StageRun[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return [...groups.entries()]
    .map(([k, g]) => ({
      key: k,
      attempts: g.length,
      failures: g.filter((r) => r.exit_code !== 0 || r.killed_reason).length,
      costUsd: g.reduce((n, r) => n + (r.cost_usd ?? 0), 0),
      tokensIn: g.reduce((n, r) => n + r.tokens_in, 0),
      tokensOut: g.reduce((n, r) => n + r.tokens_out, 0),
      avgDurationMs: Math.round(g.reduce((n, r) => n + r.duration_ms, 0) / g.length),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function savings(
  rows: readonly StageRun[],
  baselineFor: (agent: string, repo: string) => string | undefined,
): Savings {
  let actualUsd = 0;
  let baselineUsd = 0;
  let runs = 0;
  for (const r of rows) {
    const usage = { tokensIn: r.tokens_in, tokensOut: r.tokens_out, tokensCached: r.tokens_cached };
    // cost_usd is NULL whenever the count was not full, so this one check covers both.
    if (r.cost_usd === null) continue;
    const base = costFor(baselineFor(r.agent, r.repo), usage);
    if (base === undefined) continue;
    runs++;
    actualUsd += r.cost_usd;
    baselineUsd += base;
  }
  return { runs, unpriced: rows.length - runs, actualUsd, baselineUsd, savedUsd: baselineUsd - actualUsd };
}

export function analytics(
  runs: readonly Run[],
  stageRuns: readonly StageRun[],
  now = new Date(),
  baselineFor: (agent: string, repo: string) => string | undefined = () => undefined,
): Analytics {
  const finished = runs.filter((r) => FINISHED.has(r.status));
  const shipped = runs.filter((r) => r.status === "shipped").length;
  const recent = (iso: string) => now.getTime() - Date.parse(iso) <= 7 * DAY_MS;
  const endedAs = (status: string) => runs.filter((r) => r.status === status && recent(r.updated_at)).length;
  const spendSince = (days: number) =>
    stageRuns
      .filter((r) => now.getTime() - Date.parse(r.finished_at) <= days * DAY_MS)
      .reduce((n, r) => n + (r.cost_usd ?? 0), 0);
  return {
    runs: runs.length,
    shipped,
    successRate: finished.length ? shipped / finished.length : null,
    spend7dUsd: spendSince(7),
    spend30dUsd: spendSince(30),
    byStage: bucketBy(stageRuns, (r) => r.stage),
    byAgent: bucketBy(stageRuns, (r) => r.agent),
    // A run with no price on record (no agent-reported total, no pricing.ts
    // entry) is still counted, under "unknown" — never dropped silently
    // (plan v2.7.0 item 7: spend per model, visible even when incomplete).
    byModel: bucketBy(stageRuns, (r) => r.model ?? "unknown"),
    savings: savings(stageRuns, baselineFor),
    week: {
      started: runs.filter((r) => recent(r.started_at)).length,
      shipped: endedAs("shipped"),
      failed: endedAs("failed"),
    },
  };
}
