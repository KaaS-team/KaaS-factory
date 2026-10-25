// Routing for a `pool` runtime: members in the order the operator listed
// them, each with a monthly allowance in minutes copied from that provider's
// free tier. A run goes to the first member that still has `reserveMin`
// minutes left this month; the adapter cuts a run off when it reaches the
// minutes that were left, so no member runs past its allowance. With none
// left the run goes to the fallback.

export interface PoolMember {
  readonly runtime: string;
  readonly minutes: number;
}

export interface MemberUsage {
  readonly minutes: number;
  readonly lastFailure?: string;
}

// month ("2026-10", UTC) -> member runtime name -> usage.
export type PoolUsage = Readonly<Record<string, Readonly<Record<string, MemberUsage>>>>;

export const DEFAULT_RESERVE_MIN = 10;

export function monthKey(at: Date): string {
  return at.toISOString().slice(0, 7);
}

export function minutesLeft(member: PoolMember, usage: PoolUsage, month: string): number {
  return Math.max(0, member.minutes - (usage[month]?.[member.runtime]?.minutes ?? 0));
}

// The members a run may try this month, in order.
export function eligible(
  members: readonly PoolMember[],
  usage: PoolUsage,
  month: string,
  reserveMin = DEFAULT_RESERVE_MIN,
): PoolMember[] {
  return members.filter((m) => minutesLeft(m, usage, month) >= reserveMin);
}

// `usage` with `minutes` more on one member, and its last failure when the run failed as a runtime.
export function withRun(
  usage: PoolUsage,
  month: string,
  runtime: string,
  minutes: number,
  failure?: string,
): PoolUsage {
  const prev = usage[month]?.[runtime];
  const next: MemberUsage = {
    minutes: (prev?.minutes ?? 0) + minutes,
    ...(failure ? { lastFailure: failure } : prev?.lastFailure ? { lastFailure: prev.lastFailure } : {}),
  };
  return { ...usage, [month]: { ...usage[month], [runtime]: next } };
}

export interface MemberRow {
  readonly runtime: string;
  readonly allowance: number;
  readonly used: number;
  readonly left: number;
  readonly lastFailure?: string;
}

// What `factory pool` prints for one pool.
export function poolReport(members: readonly PoolMember[], usage: PoolUsage, month: string): MemberRow[] {
  return members.map((m) => {
    const u = usage[month]?.[m.runtime];
    return {
      runtime: m.runtime,
      allowance: m.minutes,
      used: Math.round((u?.minutes ?? 0) * 10) / 10,
      left: Math.round(minutesLeft(m, usage, month) * 10) / 10,
      ...(u?.lastFailure ? { lastFailure: u.lastFailure } : {}),
    };
  });
}
