// Is the factory getting cheaper and more accurate? Reads `factory learn --export` JSONL (a file, or - for
// stdin) and measures the last 20 finished runs. Operator numbers: they never reach a customer page.
//
//   bun scripts/metrics.ts <export.jsonl|->          print the three metrics
//   bun scripts/metrics.ts <export.jsonl|-> --check  exit 1 when one is over its bar

import { readFileSync } from "node:fs";

export const WINDOW = 20;
export const BARS = { planShare: 0.25, rejectsPerRun: 0.5, costPerShipped: 1.5 };

interface Row {
  type?: string;
  repo?: string;
  issue?: number;
  stage?: string;
  status?: string;
  started_at?: string;
  cost_usd?: number | null;
  verdict?: string | null;
}

const UNFINISHED = new Set(["running", "needs-info", "awaiting-approval", "verifying"]);

export interface Metrics {
  readonly runs: number;
  readonly planShare: number;
  readonly rejectsPerRun: number;
  readonly costPerShipped: number;
}

export function computeMetrics(jsonl: string): Metrics {
  const rows = jsonl
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
  const runs = rows
    .filter((r) => r.type === "run" && r.status && !UNFINISHED.has(r.status))
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
    .slice(0, WINDOW);
  const key = (r: Row) => `${r.repo}#${r.issue}`;
  const keys = new Set(runs.map(key));
  const stages = rows.filter((r) => r.type === "stage" && keys.has(key(r)));
  const spend = (rs: readonly Row[]) => rs.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
  const total = spend(stages);
  const shipped = runs.filter((r) => r.status === "shipped").length;
  return {
    runs: runs.length,
    planShare: total ? spend(stages.filter((r) => r.stage === "plan")) / total : 0,
    rejectsPerRun: runs.length
      ? stages.filter((r) => r.stage === "verify" && r.verdict === "reject").length / runs.length
      : 0,
    costPerShipped: shipped ? total / shipped : total ? Number.POSITIVE_INFINITY : 0,
  };
}

// The metrics over their bars, as lines naming each; empty when all hold.
export function overBars(m: Metrics): string[] {
  return (Object.keys(BARS) as (keyof typeof BARS)[])
    .filter((k) => m[k] > BARS[k])
    .map((k) => `${k} ${m[k].toFixed(2)} is over its bar ${BARS[k]}`);
}

if (import.meta.main) {
  const [src, flag] = process.argv.slice(2);
  if (!src) {
    console.error("usage: bun scripts/metrics.ts <export.jsonl|-> [--check]");
    process.exit(2);
  }
  const m = computeMetrics(readFileSync(src === "-" ? 0 : src, "utf8"));
  if (m.runs < WINDOW) {
    console.log(`${m.runs} finished runs, fewer than ${WINDOW}: no verdict yet`);
    process.exit(0);
  }
  for (const k of Object.keys(BARS) as (keyof typeof BARS)[]) console.log(`${k}: ${m[k].toFixed(2)} (bar ${BARS[k]})`);
  const over = overBars(m);
  if (flag === "--check" && over.length) {
    console.error(over.join("\n"));
    process.exit(1);
  }
}
