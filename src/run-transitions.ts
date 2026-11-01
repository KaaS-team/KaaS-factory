// The one writer of run status. Every change lands in the append-only events table as a
// "transition" row, so the board, metrics, MCP and audit export can read one log.

import type { FactoryState, RunStatus, Stage } from "./state";
import type { IssueView } from "./tmux";

export const TRANSITION_KIND = "transition";
export const ILLEGAL_TRANSITION_KIND = "transition-illegal";

const FINISHED: readonly RunStatus[] = ["shipped", "cancelled"];
const PARKED: readonly RunStatus[] = ["needs-info", "awaiting-approval", "needs-human", "failed", "rejected"];
const ANY: readonly RunStatus[] = [...FINISHED, ...PARKED, "running", "verifying"];

// Resuming goes through upsertRun("running"), so a finished run can only leave by running again.
export const LEGAL: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  running: ANY,
  verifying: ANY,
  "needs-info": ANY,
  "awaiting-approval": ANY,
  "needs-human": ANY,
  failed: ANY,
  rejected: ANY,
  shipped: ["running"],
  cancelled: ["running"],
};

export interface TransitionRecord {
  from: RunStatus;
  to: RunStatus;
  reason: string | null;
}

export function isLegal(from: RunStatus, to: RunStatus): boolean {
  return from === to || LEGAL[from].includes(to);
}

// An illegal move is still applied (a stuck run is worse than an odd one) but logged under its own kind.
export function transition(
  state: FactoryState,
  repo: string,
  issue: number,
  to: RunStatus,
  reason?: string,
): TransitionRecord | undefined {
  const run = state.getRun(repo, issue);
  if (!run) return undefined;
  const record: TransitionRecord = { from: run.status, to, reason: reason ?? null };
  state.updateRun(repo, issue, { status: to, reason: record.reason });
  const kind = isLegal(run.status, to) ? TRANSITION_KIND : ILLEGAL_TRANSITION_KIND;
  state.appendEvent(run.id, run.stage as Stage, kind, JSON.stringify(record));
  return record;
}

// Parked issues keep their tmux window, so the operator can still read it.
export function settle(
  state: FactoryState,
  view: IssueView | undefined,
  repo: string,
  issue: number,
  to: RunStatus,
  reason?: string,
): void {
  transition(state, repo, issue, to, reason);
  if (view && (to === "shipped" || to === "cancelled" || to === "failed"))
    view.close(issue).catch((e) => console.error(`[tmux] close #${issue}: ${e}`));
}
