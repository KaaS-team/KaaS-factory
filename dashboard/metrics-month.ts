// The factory's own numbers for one calendar month (UTC), from the state DB plus two counts read
// from GitHub; a rate with no denominator is `null`, never 0.

import type { FactoryState } from "../src/state";
import { mergesIn, shippedEntry } from "./ledger-public";

export interface MonthCounts {
  reverts: number;
  escaped: number;
}

export interface MonthMetrics {
  month: string;
  merged: number;
  medianCycleHours: number | null;
  costPerVerifiedChange: number | null;
  judgeVetoRate: number | null;
  revertRate: number | null;
  escapedDefectRate: number | null;
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function monthMetrics(
  sources: readonly { state: FactoryState; repo: string }[],
  month: string,
  counts: MonthCounts,
): MonthMetrics {
  const entries = sources.flatMap(({ state }) =>
    mergesIn(state)
      .filter((m) => m.at.startsWith(month))
      .map((m) =>
        shippedEntry(m, state.getRun(m.repo, m.issue), state.listStageRuns(m.repo, { issue: m.issue, limit: 10_000 })),
      ),
  );
  const merged = entries.length;
  const costs = entries.flatMap((e) => (e.dollars === null ? [] : [e.dollars]));
  const verdicts = sources.flatMap(({ state, repo }) =>
    state
      .listStageRuns(repo, { limit: 100_000 })
      .filter((r) => r.stage === "verify" && r.verdict !== null && r.started_at.startsWith(month)),
  );
  const vetoes = verdicts.filter((r) => r.verdict === "reject").length;
  const rate = (n: number, d: number) => (d ? round(n / d, 3) : null);
  const mid = median(entries.map((e) => e.cycleHours));
  return {
    month,
    merged,
    medianCycleHours: mid === null ? null : round(mid, 1),
    costPerVerifiedChange: costs.length ? round(costs.reduce((a, b) => a + b, 0) / costs.length, 2) : null,
    judgeVetoRate: rate(vetoes, verdicts.length),
    revertRate: rate(counts.reverts, merged),
    escapedDefectRate: rate(counts.escaped, merged),
  };
}

export function metricsMarkdown(m: MonthMetrics): string {
  const cell = (v: number | null) => (v === null ? "n/a" : String(v));
  const rows: [string, number | null][] = [
    ["Merged changes", m.merged],
    ["Median time to green (hours)", m.medianCycleHours],
    ["Cost per verified change (USD)", m.costPerVerifiedChange],
    ["Judge veto rate", m.judgeVetoRate],
    ["Revert rate", m.revertRate],
    ["Escaped-defect rate", m.escapedDefectRate],
  ];
  return [
    `# Factory metrics, ${m.month}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
    "",
    "The escaped-defect count is issues titled `Escaped defect:`; the revert count is merged PRs titled `Revert`.",
    "",
  ].join("\n");
}
