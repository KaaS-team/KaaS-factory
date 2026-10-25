// Who is working on an issue right now, shared by every worker on every
// machine: a watcher on a laptop, a CI job and a cloud routine can all poll
// the same repo, and only the lease holder advances an issue.

export interface LeasePort {
  // True when `holder` now holds `key` until `now + ttlMs`: it was free,
  // expired, or already this holder's (so the same call renews). False when
  // another holder's lease is live or another worker won the race.
  acquire(key: string, holder: string, ttlMs: number, now: number): Promise<boolean>;
  // Frees `key` if `holder` still holds it; a no-op otherwise.
  release(key: string, holder: string): Promise<void>;
}
