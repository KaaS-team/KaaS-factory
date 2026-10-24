// The dependency gate: an issue body's "Blocked by: #N, #M" line (or
// "Blocked by: none") says which issues must be closed-completed before this
// one may be picked up. Nothing else in this repo parses that line — tests
// live in tests/blockers.test.ts.
//
// pollOnce (watch.ts) calls resolveBlockers once per poll: it moves a
// LABEL.ready issue with an open blocker to LABEL.blocked (commenting once,
// on that transition only), and promotes a LABEL.blocked issue back to
// LABEL.ready the poll its last blocker clears. Nothing here talks to a
// worktree or a stage; it only reads issue state and swaps a label.

import type { GhIssue, ScmPort } from "./github";
import { LABEL } from "./labels";

const BLOCKED_BY_LINE = /^.*Blocked by:\s*(.+?)\s*$/im;

// The `#N` references on an issue's "Blocked by" line, in the order they
// appear. "Blocked by: none" (or no line at all) means no blockers.
export function blockerNumbers(body: string): number[] {
  const line = body.match(BLOCKED_BY_LINE)?.[1];
  if (!line || /^none$/i.test(line)) return [];
  return [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

// A blocker is clear once its issue is closed with a reason other than
// "not planned" — closed-not-planned means the dependency was abandoned, not
// delivered, so anything behind it stays blocked rather than building on
// work that doesn't exist. A blocker issue that can't be fetched (deleted,
// wrong number) is treated as still open: never build on a reference the
// factory can't verify.
async function blockerIsClear(github: ScmPort, repo: string, blockerNumber: number): Promise<boolean> {
  const issue = await github.getIssue(repo, blockerNumber).catch(() => undefined);
  if (!issue) return false;
  return issue.state === "CLOSED" && issue.stateReason !== "NOT_PLANNED";
}

export interface BlockerResolution {
  // Ready issues whose blockers are all clear (or had none) — safe to
  // dispatch this poll, whether they started ready or were just promoted.
  readonly clear: GhIssue[];
}

// Splits `ready` and `blocked` (the two label buckets pollOnce fetches) into
// the set that may build this poll, applying every label move and the
// one-time "why this is blocked" comment along the way.
export async function resolveBlockers(
  github: ScmPort,
  repo: string,
  ready: readonly GhIssue[],
  blocked: readonly GhIssue[],
): Promise<BlockerResolution> {
  const clear: GhIssue[] = [];

  for (const issue of ready) {
    const numbers = blockerNumbers(issue.body);
    if (numbers.length === 0) {
      clear.push(issue);
      continue;
    }
    const open = await openBlockersOf(github, repo, numbers);
    if (open.length === 0) {
      clear.push(issue);
      continue;
    }
    const names = issue.labels.map((l) => l.name);
    await github.setStateLabel(repo, issue.number, names, LABEL.blocked);
    await github.commentIssue(
      repo,
      issue.number,
      `Blocked by ${open.map((n) => `#${n}`).join(", ")} (still open). The factory will pick this up automatically once they close.`,
    );
  }

  for (const issue of blocked) {
    const numbers = blockerNumbers(issue.body);
    const open = numbers.length === 0 ? [] : await openBlockersOf(github, repo, numbers);
    if (open.length > 0) continue;
    const names = issue.labels.map((l) => l.name);
    await github.setStateLabel(repo, issue.number, names, LABEL.ready);
    clear.push({
      ...issue,
      labels: [...names.filter((n) => n !== LABEL.blocked), LABEL.ready].map((name) => ({ name })),
    });
  }

  return { clear };
}

async function openBlockersOf(github: ScmPort, repo: string, numbers: number[]): Promise<number[]> {
  const open: number[] = [];
  for (const n of numbers) {
    if (!(await blockerIsClear(github, repo, n))) open.push(n);
  }
  return open;
}
