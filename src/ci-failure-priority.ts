// Repeated CI failures of one check raise the priority of the open issue that fixes it.
// Pure data in, pure data out: the caller supplies failure records and issue text.

export interface CiFailure {
  readonly check: string;
  readonly error: string;
  readonly at: number; // epoch ms
}

export interface IssueText {
  readonly number: number;
  readonly text: string; // title and body
}

export interface BumpOptions {
  readonly now: number;
  readonly windowMs: number;
  readonly perLevel: number; // failures of one check and error per level
  readonly maxLevels: number;
}

export const DEFAULT_BUMP: Omit<BumpOptions, "now"> = {
  windowMs: 7 * 24 * 60 * 60 * 1000,
  perLevel: 3,
  maxLevels: 3,
};

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

// Failures in the window, counted per check and error.
export function groupFailures(failures: readonly CiFailure[], opts: BumpOptions): Map<string, number> {
  const groups = new Map<string, number>();
  for (const f of failures) {
    if (f.at > opts.now || opts.now - f.at > opts.windowMs) continue;
    const key = `${norm(f.check)}\n${norm(f.error)}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return groups;
}

// Levels to raise each issue: its most repeated matching group, perLevel failures per level, capped.
// An issue matches a group when its text names the check. Issues with no bump are omitted.
export function priorityBumps(
  failures: readonly CiFailure[],
  issues: readonly IssueText[],
  opts: BumpOptions,
): Map<number, number> {
  const bumps = new Map<number, number>();
  const groups = groupFailures(failures, opts);
  for (const issue of issues) {
    const text = norm(issue.text);
    let levels = 0;
    for (const [key, count] of groups) {
      const check = key.slice(0, key.indexOf("\n"));
      if (check !== "" && text.includes(check)) levels = Math.max(levels, Math.floor(count / opts.perLevel));
    }
    if (levels > 0) bumps.set(issue.number, Math.min(levels, opts.maxLevels));
  }
  return bumps;
}

// Higher bump first, then issue number: with no bumps this is the old order.
export function orderByBump<T extends { readonly issue: number }>(
  jobs: readonly T[],
  bumps: ReadonlyMap<number, number>,
): T[] {
  return [...jobs].sort((a, b) => (bumps.get(b.issue) ?? 0) - (bumps.get(a.issue) ?? 0) || a.issue - b.issue);
}
