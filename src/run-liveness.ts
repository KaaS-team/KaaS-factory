// The board shows only what is true now. A run row says "running" until something rewrites it, so a
// crash, a kill or an issue closed by hand left rows under Running for days (#617). Each poll ends them.

import type { FactoryConfig } from "./config";
import { finish } from "./engine/common";
import type { WatchDeps } from "./engine/common";
import { transition } from "./run-transitions";

export const LIVE_STATUSES: ReadonlySet<string> = new Set(["running", "verifying"]);
// No process of this watcher holds the run and nothing was written for this long: it is dead.
export const STALE_RUN_MS = 10 * 60_000;

// Returns the issues it ended. A closed issue becomes shipped when it was completed, else cancelled.
export async function settleDeadRuns(
  deps: WatchDeps,
  config: FactoryConfig,
  inFlight: Set<number> | undefined,
  now: number,
): Promise<number[]> {
  const ended: number[] = [];
  for (const run of deps.state.listRuns(config.repo)) {
    if (!LIVE_STATUSES.has(run.status) || inFlight?.has(run.issue)) continue;
    try {
      const issue = await deps.github.getIssue(config.repo, run.issue);
      if (issue.state === "CLOSED") {
        const shipped = issue.stateReason === "COMPLETED";
        finish(deps, config, run.issue, shipped ? "shipped" : "cancelled", "issue closed");
      } else if (now - Date.parse(deps.state.lastActivity(run)) > STALE_RUN_MS) {
        transition(deps.state, config.repo, run.issue, "interrupted", "no live process and no recent event");
      } else continue;
      ended.push(run.issue);
    } catch (err) {
      console.error(`settling run #${run.issue} failed:`, err);
    }
  }
  return ended;
}
