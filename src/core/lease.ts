// The lease record and the one rule for taking it. Clocks are the workers'
// own, so the TTL (30 s) is far longer than any sane skew.

export interface LeaseRecord {
  readonly holder: string;
  // Epoch ms; 0 is a released lease.
  readonly expiresAt: number;
}

export const LEASE_TTL_MS = 30_000;
export const LEASE_HEARTBEAT_MS = 10_000;

export function mayTake(current: LeaseRecord | undefined, holder: string, now: number): boolean {
  return !current || current.holder === holder || current.expiresAt <= now;
}

export function encodeLease(r: LeaseRecord): string {
  return JSON.stringify({ holder: r.holder, expiresAt: r.expiresAt });
}

// Anything unreadable counts as free: a lease no worker can parse protects nothing.
export function decodeLease(text: string): LeaseRecord | undefined {
  try {
    const v = JSON.parse(text.trim()) as Partial<LeaseRecord>;
    return typeof v.holder === "string" && typeof v.expiresAt === "number"
      ? { holder: v.holder, expiresAt: v.expiresAt }
      : undefined;
  } catch {
    return undefined;
  }
}
