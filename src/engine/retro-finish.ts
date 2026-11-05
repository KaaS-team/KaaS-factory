// What a finished run leaves behind for retro: the row finish() queues, the coverage figure, the prune lesson.
import type { FactoryState, RetroTrigger } from "../state";

// The retro each run ending queues when nothing ran one first; runQueuedRetros drains it.
export const RETRO_ON_FINISH: Readonly<Record<string, RetroTrigger>> = {
  failed: "gave-up",
  cancelled: "rejected",
  shipped: "merged",
};

// A plan-rubric row is a lesson about the plan, not the retro of a finished run.
export function hasRetro(state: FactoryState, repo: string, issue: number): boolean {
  return state.listRetros(repo, 1_000_000).some((r) => r.issue === issue && r.outcome !== "plan-rubric");
}

// A shipped run with a PR is still waiting for its merge, which runs the retro.
export function queueFinishRetro(state: FactoryState, repo: string, issue: number, status: string): void {
  const trigger = RETRO_ON_FINISH[status];
  const run = state.getRun(repo, issue);
  if (!trigger || !run || (status === "shipped" && run.pr_url)) return;
  if (!hasRetro(state, repo, issue)) state.queueRetro(repo, issue, trigger);
}

// Runs that are over (failed, cancelled, or shipped with no PR to wait on) against those with a retro.
// A run that resumes and ends again keeps its one row per issue, so its first retro covers it.
export function retroCoverage(
  state: FactoryState,
  repo: string,
): { finished: number; covered: number; percent: number; missing: number[] } {
  const done = state
    .listRuns(repo)
    .filter((r) => r.status === "failed" || r.status === "cancelled" || (r.status === "shipped" && !r.pr_url));
  const missing = done.filter((r) => !hasRetro(state, repo, r.issue)).map((r) => r.issue);
  const covered = done.length - missing.length;
  return { finished: done.length, covered, percent: done.length === 0 ? 100 : (covered / done.length) * 100, missing };
}

// The scaffold tests a plan tagged, as one lesson: each is deleted or retagged permanent in its plan.
export function pruneLesson(issue: number, plan: unknown): string | undefined {
  const tests = (plan as { scaffoldTests?: unknown } | undefined)?.scaffoldTests;
  const names = Array.isArray(tests) ? tests.filter((t): t is string => typeof t === "string") : [];
  if (names.length === 0) return undefined;
  return `[check] Prune or graduate the scaffold tests of #${issue}: ${names.join("; ")}. Delete each one, or keep it as permanent if it still guards a behaviour.`;
}

// Its own row: the agent's row holds at most one proposal, and this one never depends on the agent.
export function queuePrune(
  state: FactoryState,
  repo: string,
  issue: number,
  outcome: RetroTrigger,
  plan: unknown,
): void {
  const lesson = pruneLesson(issue, plan);
  if (lesson) state.completeRetro(state.queueRetro(repo, issue, outcome), { lesson });
}
