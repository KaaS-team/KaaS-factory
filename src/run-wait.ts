// Event-driven wait on one run. The server keeps a bounded history of run changes, each with a
// sequence number. A waiter is answered when an event arrives, not by polling. A client whose
// cursor fell out of the history gets `events_lost`, fetches the snapshot and resumes from its seq.

import type { RunStatus, Stage } from "./state";

export const RUN_HISTORY_SIZE = 256;

export interface RunView {
  status: RunStatus;
  stage: Stage;
}
export interface RunEvent {
  seq: number;
  patch: Partial<RunView>;
}
export interface RunSnapshot {
  seq: number;
  view: RunView;
}

/** Statuses where the run waits on a person, so a prompt sent now would not be read. */
const BLOCKED: ReadonlySet<RunStatus> = new Set(["needs-info", "awaiting-approval", "needs-human"]);
export function isBlocked(status: RunStatus): boolean {
  return BLOCKED.has(status);
}

/** The one reducer: a fast client applies each event, a slow one applies a snapshot, both land here. */
export function applyEvent(view: RunView, e: RunEvent): RunView {
  return { ...view, ...e.patch };
}

export type Since = { events: RunEvent[] } | { events_lost: true };

export class RunHistory {
  private readonly events: RunEvent[] = [];
  private seq = 0;
  private view: RunView;
  private readonly listeners = new Set<() => void>();

  constructor(
    initial: RunView,
    private readonly limit = RUN_HISTORY_SIZE,
  ) {
    this.view = { ...initial };
  }

  push(patch: Partial<RunView>): RunEvent {
    const e: RunEvent = { seq: ++this.seq, patch };
    this.view = applyEvent(this.view, e);
    this.events.push(e);
    if (this.events.length > this.limit) this.events.shift();
    for (const fn of [...this.listeners]) fn();
    return e;
  }

  snapshot(): RunSnapshot {
    return { seq: this.seq, view: { ...this.view } };
  }

  /** Events after `cursor`; `events_lost` when the cursor is older than the oldest kept event or from the future. */
  since(cursor: number): Since {
    const oldestKept = this.seq - this.events.length; // the cursor is current when it equals this or more
    if (!Number.isInteger(cursor) || cursor < oldestKept || cursor > this.seq) return { events_lost: true };
    return { events: this.events.filter((e) => e.seq > cursor) };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}

export type WaitResult =
  | { result: "reached"; snapshot: RunSnapshot }
  | { result: "timeout"; snapshot: RunSnapshot }
  | { result: "events_lost"; snapshot: RunSnapshot };

/**
 * Resolves when the run's status is `until`, on the event that makes it so. A cursor that fell out of
 * the history resolves `events_lost` at once, with the snapshot to resume from.
 */
export function waitForStatus(
  history: RunHistory,
  opts: { until: RunStatus; timeoutMs: number; cursor?: number },
): Promise<WaitResult> {
  const reached = () => history.snapshot().view.status === opts.until;
  if (opts.cursor !== undefined && "events_lost" in history.since(opts.cursor)) {
    return Promise.resolve({ result: "events_lost", snapshot: history.snapshot() });
  }
  if (reached()) return Promise.resolve({ result: "reached", snapshot: history.snapshot() });
  return new Promise((resolve) => {
    const done = (r: WaitResult["result"]) => {
      clearTimeout(timer);
      unsubscribe();
      resolve({ result: r, snapshot: history.snapshot() });
    };
    const unsubscribe = history.subscribe(() => {
      if (reached()) done("reached");
    });
    const timer = setTimeout(() => done("timeout"), opts.timeoutMs);
  });
}

/** A client that follows a run: applies events, and on `events_lost` replaces its state with the snapshot. */
export class RunFollower {
  constructor(
    public view: RunView,
    public cursor: number,
  ) {}

  /** Catch up from the history. Returns true when events were lost and a snapshot was used. */
  catchUp(history: RunHistory): boolean {
    const missed = history.since(this.cursor);
    if ("events_lost" in missed) {
      const snap = history.snapshot();
      this.view = snap.view;
      this.cursor = snap.seq;
      return true;
    }
    for (const e of missed.events) {
      this.view = applyEvent(this.view, e);
      this.cursor = e.seq;
    }
    return false;
  }
}

export type PromptResult = { sent: true } | { sent: false; error: "run_blocked"; status: RunStatus };

/** Sends a prompt unless the run is blocked; a blocked run returns `run_blocked` and `send` is never called. */
export async function sendPrompt(history: RunHistory, send: () => Promise<void>): Promise<PromptResult> {
  const { status } = history.snapshot().view;
  if (isBlocked(status)) return { sent: false, error: "run_blocked", status };
  await send();
  return { sent: true };
}
