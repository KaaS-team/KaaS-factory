// Routing for a `pool` runtime: members in the order the operator listed
// them, each with a monthly allowance in minutes copied from that provider's
// free tier. Before a run, a member's minutes are reserved: everything it has
// left after what it used and what other runs hold, but only if that is at
// least `reserveMin`. The adapter cuts the run off at the minutes it holds, so
// two runs at once can never take a member past its allowance together.

export interface PoolMember {
  readonly runtime: string;
  readonly minutes: number;
}

// One member's month: minutes used by finished runs, minutes held by running ones.
export interface MemberMonth {
  readonly used: number;
  readonly held: number;
  readonly lastFailure?: string;
}

export const DEFAULT_RESERVE_MIN = 10;

export function monthKey(at: Date): string {
  return at.toISOString().slice(0, 7);
}

export function minutesLeft(member: PoolMember, month: MemberMonth | undefined): number {
  return Math.max(0, member.minutes - (month?.used ?? 0) - (month?.held ?? 0));
}

// The minutes a new run may hold on `member`, or 0 when it may not run there.
export function grant(member: PoolMember, month: MemberMonth | undefined, reserveMin = DEFAULT_RESERVE_MIN): number {
  const left = minutesLeft(member, month);
  return left >= reserveMin ? left : 0;
}

export interface MemberRow {
  readonly runtime: string;
  readonly allowance: number;
  readonly used: number;
  readonly left: number;
  readonly lastFailure?: string;
}

const tenth = (n: number) => Math.round(n * 10) / 10;

// What `factory pool` prints for one pool.
export function poolReport(members: readonly PoolMember[], months: Readonly<Record<string, MemberMonth>>): MemberRow[] {
  return members.map((m) => {
    const u = months[m.runtime];
    return {
      runtime: m.runtime,
      allowance: m.minutes,
      used: tenth(u?.used ?? 0),
      left: tenth(minutesLeft(m, u)),
      ...(u?.lastFailure ? { lastFailure: u.lastFailure } : {}),
    };
  });
}
