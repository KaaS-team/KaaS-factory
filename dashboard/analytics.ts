// What the Analytics view shows, computed from stage_runs and runs. The
// server sends numbers; the page only draws them.

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

export function analytics(runs: readonly Run[], stageRuns: readonly StageRun[], now = new Date()): Analytics {
  const finished = runs.filter((r) => FINISHED.has(r.status));
  const shipped = runs.filter((r) => r.status === "shipped").length;
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
  };
}
