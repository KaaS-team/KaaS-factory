// The numbers behind metrics.get and get_task_report. A metric with no data is left out of the
// object, never reported as 0; cost is only included when the caller is an operator.

import type { FactoryConfig } from "./config";
import { evidenceReport } from "./merge-evidence";
import type { Run, StageRun } from "./state";

export interface MetricsState {
  listRuns(repo?: string): Run[];
  listStageRuns(repo: string, opts?: { issue?: number; after?: number; limit?: number }): StageRun[];
}

export interface Metrics {
  mergeRate?: number;
  costPerMergedChange?: number;
  judgeVetoRate?: number;
  unknownVerdicts?: number;
  // One read-only report per repo whose source carries its config and a settings store.
  mergeEvidence?: { repo: string; report: string }[];
}

export interface MetricsSource {
  repo: string;
  state: MetricsState & { getSetting?(key: string): string | undefined };
  // Without the config there is no protected-path list to report on, so the repo is skipped.
  config?: FactoryConfig;
}

const ENDED = new Set(["shipped", "failed", "cancelled", "rejected"]);
const ALL = 100_000;
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

export function metricsFor(sources: readonly MetricsSource[], opts: { operator: boolean }): Metrics {
  const runs = sources.flatMap(({ repo, state }) => state.listRuns(repo));
  const ended = runs.filter((r) => ENDED.has(r.status));
  const shipped = runs.filter((r) => r.status === "shipped");
  const out: Metrics = {};
  if (ended.length) out.mergeRate = round(shipped.length / ended.length, 3);

  const verdicts = sources.flatMap(({ repo, state }) =>
    state.listStageRuns(repo, { limit: ALL }).filter((s) => s.stage === "verify" && s.verdict !== null),
  );
  const known = verdicts.filter((s) => s.verdict !== "unknown");
  if (known.length) out.judgeVetoRate = round(known.filter((s) => s.verdict === "reject").length / known.length, 3);
  if (verdicts.length > known.length) out.unknownVerdicts = verdicts.length - known.length;

  const evidence = sources.flatMap(({ repo, state, config }) =>
    config && state.getSetting
      ? [{ repo, report: evidenceReport({ getSetting: state.getSetting.bind(state), setSetting() {} }, config) }]
      : [],
  );
  if (evidence.length) out.mergeEvidence = evidence;

  if (opts.operator && shipped.length) {
    const attempts = shipped.flatMap((r) => {
      const src = sources.find((s) => s.repo === r.repo);
      return src ? src.state.listStageRuns(r.repo, { issue: r.issue, limit: ALL }) : [];
    });
    // One unknown cost makes the total unknown, so the metric is omitted rather than understated.
    if (attempts.length && attempts.every((a) => a.cost_usd !== null)) {
      out.costPerMergedChange = round(attempts.reduce((n, a) => n + (a.cost_usd ?? 0), 0) / shipped.length, 2);
    }
  }
  return out;
}

export interface TaskReport {
  repo: string;
  issue: number;
  status: Run["status"];
  stages: { stage: string; verdict?: string; costUsd?: number }[];
  costUsd?: number;
}

export function getTaskReport(
  repo: string,
  state: MetricsState,
  issue: number,
  opts: { operator: boolean },
): TaskReport | undefined {
  const run = state.listRuns(repo).find((r) => r.issue === issue);
  if (!run) return undefined;
  const attempts = state.listStageRuns(repo, { issue, limit: ALL });
  const stages = attempts.map((a) => ({
    stage: a.stage,
    ...(a.verdict !== null ? { verdict: a.verdict } : {}),
    ...(opts.operator && a.cost_usd !== null ? { costUsd: a.cost_usd } : {}),
  }));
  const known = attempts.length > 0 && attempts.every((a) => a.cost_usd !== null);
  return {
    repo,
    issue,
    status: run.status,
    stages,
    ...(opts.operator && known
      ? {
          costUsd: round(
            attempts.reduce((n, a) => n + (a.cost_usd ?? 0), 0),
            2,
          ),
        }
      : {}),
  };
}
