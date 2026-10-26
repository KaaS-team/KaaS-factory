// The gh budget for the issue and PR lists every page polls. A repo whose webhooks arrive is told
// about changes, so it can wait longer between reads; a token near its rate limit waits twice as long.
import type { RateBudget } from "../../src/ports/scm";

export const POLL_MS = 10_000;
export const HOOKED_MS = 120_000;
// A repo counts as hooked while a delivery came within this window.
export const HOOK_WINDOW_MS = 60 * 60_000;
export const RATE_CHECK_MS = 60_000;
export const LOW_RATE = 0.1;

type Kind = "issues" | "prs";

export interface BoardCacheOptions {
  // Undefined when the code host has no budget to read; the TTL then never doubles.
  rate?: (repo: string) => Promise<RateBudget>;
  now?: () => number;
}

export function boardCache(opts: BoardCacheOptions = {}) {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { at: number; value: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();
  const heardAt = new Map<string, number>();
  // Per owner, since an App installation (and its budget) is per owner.
  const rates = new Map<string, { at: number; low: boolean }>();

  async function low(repo: string): Promise<boolean> {
    if (!opts.rate) return false;
    const owner = repo.split("/")[0]!;
    const seen = rates.get(owner);
    if (seen && now() - seen.at < RATE_CHECK_MS) return seen.low;
    const b = await opts.rate(repo).catch(() => null);
    const isLow = !!b && b.limit > 0 && b.remaining / b.limit < LOW_RATE;
    rates.set(owner, { at: now(), low: isLow });
    return isLow;
  }

  async function ttl(repo: string): Promise<number> {
    const heard = heardAt.get(repo);
    const base = heard !== undefined && now() - heard < HOOK_WINDOW_MS ? HOOKED_MS : POLL_MS;
    return (await low(repo)) ? base * 2 : base;
  }

  // Single-flight per (kind, repo), so many tabs polling turn into one gh call per TTL.
  async function read<T>(kind: Kind, repo: string, load: () => Promise<T>): Promise<T> {
    const key = `${kind}\n${repo}`;
    const hit = hits.get(key);
    if (hit && now() - hit.at < (await ttl(repo))) return hit.value as T;
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = load()
      .then((value) => {
        hits.set(key, { at: now(), value });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    read,
    ttl,
    // A write the plane made itself: the next board read shows it.
    invalidate: (repo: string) => hits.delete(`issues\n${repo}`),
    // A delivery for this repo: only its lists are read again, and it keeps the longer TTL.
    heard(repo: string) {
      heardAt.set(repo, now());
      hits.delete(`issues\n${repo}`);
      hits.delete(`prs\n${repo}`);
    },
  };
}
