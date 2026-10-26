// Durable resume: the event log is the run's journal. A run that starts again (retry, crash, an
// approval resolved by token) replays the steps it shows finished, with their facts, instead of
// paying for them twice. Only the same workflow file (its sha) counts, so an edit runs from the top.

import type { Workflow } from "../core/workflow";
import { LABEL } from "../labels";
import { emitEvent } from "./bus";
import type { WatchDeps } from "./common";
import type { FactoryConfig } from "../config";

interface Finished {
  readonly result: string;
  readonly facts?: unknown;
}

export interface Journal {
  readonly finished: ReadonlyMap<string, Finished>;
  // Steps whose latest approval token was resolved "approve".
  readonly approved: ReadonlySet<string>;
}

// The newest events are enough: one issue's run is a few dozen of them, and older ones end in a
// run.completed that closes the window anyway.
const WINDOW = 5000;
const ENDED = new Set(["shipped", "cancelled"]);

type Row = { type: string; subject: string | null; data: string };
const dataOf = (r: Row): Record<string, unknown> => {
  try {
    return (JSON.parse(r.data) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
};

export function readJournal(
  state: { busEvents(limit?: number, after?: number): Row[] },
  issue: number,
  workflow: Workflow,
): Journal {
  const rows = state.busEvents(WINDOW).filter((r) => r.subject === `issue/${issue}`);
  const finished = new Map<string, Finished>();
  const tokens = new Map<string, string>();
  const approved = new Set<string>();
  for (const r of rows) {
    const d = dataOf(r);
    if (r.type === "factory.run.completed" && ENDED.has(String(d.outcome))) finished.clear(), approved.clear();
    if (d.workflow !== workflow.name || d.sha !== workflow.sha) continue;
    const step = String(d.step);
    if (r.type === "factory.step.completed") finished.set(step, { result: String(d.result), facts: d.facts });
    else if (r.type === "factory.step.failed" || r.type === "factory.step.started") finished.delete(step);
    else if (r.type === "factory.approval.requested") tokens.set(String(d.token), step), approved.delete(step);
    else if (r.type === "factory.approval.resolved" && d.decision === "approve" && tokens.has(String(d.token)))
      approved.add(tokens.get(String(d.token))!);
  }
  return { finished, approved };
}

export type Decision = "approve" | "revise";

// The wait-for-event token a park hands out. Resolving it records the decision and puts the issue
// back in factory:ready, where pickup replays the journal up to the approved step and goes on.
export async function resolveApproval(
  deps: Pick<WatchDeps, "state" | "bus" | "github">,
  config: FactoryConfig,
  token: string,
  decision: Decision,
  by: string,
): Promise<{ issue: number; step: string } | { error: string }> {
  const rows = deps.state.busEvents(WINDOW);
  const asked = rows.find((r) => r.type === "factory.approval.requested" && dataOf(r).token === token);
  if (!asked) return { error: "no approval waits on that token" };
  if (rows.some((r) => r.type === "factory.approval.resolved" && dataOf(r).token === token))
    return { error: "that approval is already resolved" };
  const d = dataOf(asked);
  const issue = Number(d.issue);
  emitEvent(deps.bus, "factory.approval.resolved", { ...d, decision, by }, asked.subject ?? undefined);
  await deps.github.setStateLabel(config.repo, issue, [LABEL.awaitingApproval], LABEL.ready);
  return { issue, step: String(d.step) };
}
