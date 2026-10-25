// Holds an issue's lease for the length of `work`: acquire, renew on a
// heartbeat, release at the end. A renewal that fails (the lease expired and
// another worker took it, or the remote is unreachable past the TTL) marks it
// lost, and the runner stops at the next step boundary instead of racing the
// new holder.

import { LEASE_HEARTBEAT_MS, LEASE_TTL_MS } from "../core/lease";
import type { LeasePort } from "../ports/lease";

export interface LeaseOpts {
  readonly ttlMs?: number;
  readonly everyMs?: number;
  readonly now?: () => number;
}

export interface Held {
  lost: boolean;
}

// undefined when another worker holds the lease: nothing ran.
export async function withLease<T>(
  port: LeasePort,
  key: string,
  holder: string,
  work: (held: Held) => Promise<T>,
  opts: LeaseOpts = {},
): Promise<T | undefined> {
  const ttl = opts.ttlMs ?? LEASE_TTL_MS;
  const now = opts.now ?? Date.now;
  if (!(await port.acquire(key, holder, ttl, now()))) return undefined;
  const held: Held = { lost: false };
  let beating = Promise.resolve();
  const timer = setInterval(() => {
    beating = beating.then(async () => {
      if (held.lost) return;
      if (!(await port.acquire(key, holder, ttl, now()).catch(() => false))) held.lost = true;
    });
  }, opts.everyMs ?? LEASE_HEARTBEAT_MS);
  try {
    return await work(held);
  } finally {
    clearInterval(timer);
    await beating;
    // A no-op if the lease was lost: release only frees a lease this holder still has.
    await port.release(key, holder);
  }
}
