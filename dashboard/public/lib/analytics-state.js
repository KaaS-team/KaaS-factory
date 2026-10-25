// Ported from owainlewis/machinist@3943516 internal/controlplane/web/src/analytics-state.js:1-end (MIT, Copyright (c) 2026 Owain Lewis). Deviations: none; verbatim.
import { completedRunsForTasks, taskAnalytics } from "./run-metrics.js";

export function analyticsState({ jobs, days, loaded, error, now }) {
  if (error) return { kind: "error", message: error };
  if (!loaded) return { kind: "loading" };

  const metrics = taskAnalytics(jobs, days, now);
  const runs = completedRunsForTasks(metrics.tasks);
  return metrics.totalTasks ? { kind: "ready", metrics, runs } : { kind: "empty", metrics, runs };
}
