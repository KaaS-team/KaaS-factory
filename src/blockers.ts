// The dependency gate: an issue body's "Blocked by: #N, #M" line (or
// "Blocked by: none") and its "Deps: #N" line say which issues must be
// closed-completed before this one may be picked up. Nothing else in this repo
// parses those lines — tests live in tests/blockers.test.ts.
//
// pollOnce (watch.ts) calls resolveBlockers once per poll: it moves a
// LABEL.ready issue with an open blocker to LABEL.blocked (commenting once,
// on that transition only), and promotes a LABEL.blocked issue back to
// LABEL.ready the poll its last blocker clears. Runner: operator work goes to
// LABEL.operator instead of ready. Nothing here talks to a worktree or a stage;
// it only reads issue state and swaps a label.

import { parseMeta, type SchedNode, schedule, orderIssues } from "./core/schedule";
import type { GhIssue, ScmPort } from "./github";
import { parsePlannedIssue } from "./engine/import-plan";
import { LABEL } from "./labels";
import { plannedFiles } from "./overlap";

const BLOCKED_BY_LINE = /^.*Blocked by:\s*(.+?)\s*$/im;

// The `#N` references on an issue's "Blocked by" line and its "Deps" line, the
// union in the order they appear. "none" (or no line at all) means no blockers.
export function blockerNumbers(body: string): number[] {
  const line = body.match(BLOCKED_BY_LINE)?.[1];
  const fromLine = !line || /^none$/i.test(line) ? [] : [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  return [...new Set([...fromLine, ...parseMeta(body).deps])];
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
  // One lookup per poll: two issues waiting on the same dep fetch it once.
  const lookup = new Map<number, Promise<boolean>>();
  const clearOf = (n: number): Promise<boolean> => {
    let known = lookup.get(n);
    if (!known) {
      known = blockerIsClear(github, repo, n);
      lookup.set(n, known);
    }
    return known;
  };

  for (const issue of ready) {
    const open = await openBlockersOf(blockerNumbers(issue.body), clearOf);
    if (open.length === 0) {
      if (await operatorHold(github, repo, issue)) continue;
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
    const open = await openBlockersOf(blockerNumbers(issue.body), clearOf);
    if (open.length > 0) continue;
    if (await operatorHold(github, repo, issue)) continue;
    const names = issue.labels.map((l) => l.name);
    await github.setStateLabel(repo, issue.number, names, LABEL.ready);
    clear.push({
      ...issue,
      labels: [...names.filter((n) => n !== LABEL.blocked), LABEL.ready].map((name) => ({ name })),
    });
  }

  return { clear };
}

// Operator work is a human's job: the factory parks it and says so once, on the
// transition, and the issues that depend on it start when a human closes it.
async function operatorHold(github: ScmPort, repo: string, issue: GhIssue): Promise<boolean> {
  if (parseMeta(issue.body).runner !== "operator") return false;
  await github.setStateLabel(repo, issue.number, issue.labels.map((l) => l.name), LABEL.operator);
  await github.commentIssue(
    repo,
    issue.number,
    "Operator work (Runner: operator): the factory will not build this. Close it when it is done; issues that depend on it start then.",
  );
  return true;
}

async function openBlockersOf(numbers: number[], clearOf: (n: number) => Promise<boolean>): Promise<number[]> {
  const open: number[] = [];
  for (const n of numbers) {
    if (!(await clearOf(n))) open.push(n);
  }
  return open;
}

// Declared issues ready to start, in the order the scheduler says: critical
// path first, then the rest. Undeclared and resumed issues keep their place.
// `slots` is how many new declared pickups this poll may take.
export function scheduleOrder(candidates: readonly GhIssue[], context: readonly GhIssue[], slots: number): GhIssue[] {
  const isReady = (issue: GhIssue): boolean => issue.labels.some((l) => l.name === LABEL.ready);
  const isNewDeclared = (issue: GhIssue): boolean => parseMeta(issue.body).declared && isReady(issue);
  const contextNumbers = new Set(context.map((i) => i.number));
  // A candidate wins over its context copy: dispatch's blocked list can still hold an issue resolveBlockers just promoted.
  const byNumber = new Map<number, GhIssue>([...context, ...candidates].map((i) => [i.number, i] as const));
  const nodes = [...byNumber.values()]
    .filter((i) => parseMeta(i.body).declared && (isReady(i) || contextNumbers.has(i.number)))
    .map(schedNode);
  const open = new Set(byNumber.keys());
  const plan = schedule({ nodes, open, slots });
  const picked = new Set(plan.batch);
  return orderIssues(candidates, plan, isNewDeclared).filter((i) => !isNewDeclared(i) || picked.has(i.number));
}

// One issue as the scheduler sees it; `factory plan-order` builds its graph the same way the watcher does.
export function schedNode(issue: GhIssue): SchedNode {
  const meta = parseMeta(issue.body);
  const files = parsePlannedIssue(issue.body).plan?.files.map((f) => f.path) ?? plannedFiles(issue);
  return {
    number: issue.number,
    deps: blockerNumbers(issue.body),
    files,
    epic: meta.epic,
    milestone: meta.milestone,
    runner: meta.runner,
  };
}
