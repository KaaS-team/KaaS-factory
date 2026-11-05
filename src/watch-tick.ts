// Poll timing and the in-flight bookkeeping src/watch.ts shares across overlapping polls.

export interface PollResult {
  readonly paused: boolean;
  readonly reason?: string;
  readonly processed: number[];
  // Epoch ms before which the tracker must not be called again (it rate limited this tick).
  readonly nextTickAt?: number;
}

export const MAX_BACKOFF_MS = 900_000;

// How long to wait before the next tick, and whether a tick may call the tracker now.
export const tickDelay = (intervalMs: number, nextTickAt: number | undefined, now: number): number =>
  Math.max(intervalMs, (nextTickAt ?? 0) - now);
export const tickDue = (nextTickAt: number | undefined, now: number): boolean => (nextTickAt ?? 0) <= now;

// `inFlight` spans overlapping polls (plan v2.7.0 item 6), so a busy issue never reaches a second
// runPool. A poll that listed issues before one was released holds a stale copy and must skip it:
// `releasedAt` records when, in `releaseSeq` order. Absent, every poll is self-contained.
const releasedAt = new WeakMap<Set<number>, Map<number, number>>();
let seq = 0;
export const releaseSeq = (): number => seq;

export function release(inFlight: Set<number> | undefined, issue: number): void {
  if (!inFlight?.delete(issue)) return;
  const seqs = releasedAt.get(inFlight) ?? new Map<number, number>();
  releasedAt.set(inFlight, seqs);
  seqs.set(issue, ++seq);
}

// True when `issue` left `inFlight` after a poll listed at `listedAt`, so that poll's copy is stale.
export function releasedSince(inFlight: Set<number> | undefined, issue: number, listedAt: number): boolean {
  const released = inFlight ? releasedAt.get(inFlight)?.get(issue) : undefined;
  return released !== undefined && released > listedAt;
}
