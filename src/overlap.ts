// Serialises issues that plan to change the same files: two builds on one file make the later PR
// conflict and get rebuilt. The check runs where a plan becomes a build (the earliest point the
// files are known), and the later issue waits under LABEL.overlap until the earlier ones leave flight.

import type { FactoryConfig } from "./config";
import { isHumanComment, isTrusted, parseChatOps } from "./chatops";
import type { Step, Workflow } from "./core/workflow";
import { latestDataFor, parseDataMarkers } from "./derive";
import { finish, moveLabel, postComment, type Outcome, type WatchDeps } from "./engine/common";
import type { GhIssue } from "./github";
import { LABEL } from "./labels";

export interface Planned {
  readonly issue: number;
  readonly files: readonly string[];
  // Building, verifying, in review, or cleared to build: it holds its files whatever its number.
  readonly started: boolean;
}

export interface Overlap {
  readonly issue: number;
  readonly shared: readonly string[];
}

// An issue still waiting blocks only a higher number, so two waiting issues never wait on each other.
export function overlapping(self: Pick<Planned, "issue" | "files">, inFlight: readonly Planned[]): Overlap[] {
  const mine = new Set(self.files);
  return inFlight
    .filter((o) => o.started || o.issue < self.issue)
    .map((o) => ({ issue: o.issue, shared: o.files.filter((f) => mine.has(f)) }))
    .filter((o) => o.shared.length > 0);
}

// The files the issue's latest plan names, from the plan comment's data marker.
export function plannedFiles(issue: Pick<GhIssue, "comments">): string[] {
  const plan = latestDataFor(parseDataMarkers(issue.comments.filter(isTrusted)), "plan") as
    | { files?: unknown }
    | undefined;
  return Array.isArray(plan?.files) ? plan.files.filter((f): f is string => typeof f === "string") : [];
}

const STARTED_LABELS: readonly string[] = [LABEL.building, LABEL.verifying, LABEL.inReview];

// An issue that passed the check but has no building label yet (its worktree is being made) still
// counts, so two approved in one poll cannot both pass. Dropped once its label shows or after the TTL.
const CLEARED_TTL_MS = 120_000;
const cleared = new WeakMap<WatchDeps, Map<number, { files: readonly string[]; at: number }>>();

// The decision after the awaits is synchronous, so the check and the clearance cannot interleave.
export async function overlapsOf(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: number,
  files: readonly string[],
): Promise<Overlap[]> {
  const labels = [...STARTED_LABELS, LABEL.overlap];
  const lists = await Promise.all(labels.map((l) => deps.github.listIssuesByLabel(config.repo, l)));
  const plans = new Map<number, Planned>();
  lists.forEach((list, i) => {
    for (const it of list) {
      if (it.number === issue) continue;
      const started = plans.get(it.number)?.started || STARTED_LABELS.includes(labels[i]!);
      plans.set(it.number, { issue: it.number, files: plannedFiles(it), started });
    }
  });
  const now = (deps.now?.() ?? new Date()).getTime();
  const mine = cleared.get(deps) ?? new Map();
  cleared.set(deps, mine);
  for (const [n, c] of mine) {
    if (plans.has(n) || now - c.at > CLEARED_TTL_MS) mine.delete(n);
    else if (n !== issue) plans.set(n, { issue: n, files: c.files, started: true });
  }
  const blockers = overlapping({ issue, files }, [...plans.values()]);
  if (blockers.length === 0) mine.set(issue, { files, at: now });
  else mine.delete(issue);
  return blockers;
}

// True when the issue was put to wait: moved off `from`, told why in one comment, and parked.
export async function holdForOverlap(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: number,
  files: readonly string[],
  from: string,
): Promise<boolean> {
  const blockers = await overlapsOf(deps, config, issue, files);
  if (blockers.length === 0) return false;
  const first = blockers[0]!;
  const others = blockers.length > 1 ? ` (and ${blockers.length - 1} more)` : "";
  await moveLabel(deps, config, issue, from, LABEL.overlap);
  await postComment(
    deps,
    config,
    issue,
    `This plan touches ${first.shared.join(", ")}, which #${first.issue} is already changing${others}. The factory will start building once those PRs merge or close.`,
    { stage: "overlap", json: { blockedBy: blockers.map((b) => b.issue) } },
  );
  finish(deps, config, issue, "awaiting-approval", "waiting on an earlier issue that changes the same files");
  return true;
}

// A human approving a plan that would go on to build goes through the same check as an auto-approval.
export async function holdApproved(
  deps: WatchDeps,
  config: FactoryConfig,
  workflow: Workflow,
  issue: GhIssue,
  stepId: string,
): Promise<boolean> {
  if (workflow.steps[stepId]?.uses !== "build") return false;
  return holdForOverlap(deps, config, issue.number, plannedFiles(issue), LABEL.awaitingApproval);
}

// A plan held for an overlap goes on to build, with no further comment, the poll the earlier issues
// leave flight. `ops` are the runner's own cancel and resume, which live in watch.ts.
export async function resumeOverlap(
  deps: WatchDeps,
  config: FactoryConfig,
  workflow: Workflow,
  issue: GhIssue,
  ops: { cancel: () => Promise<Outcome>; build: (step: Step) => Promise<Outcome> },
): Promise<Outcome> {
  const latest = issue.comments.filter((c) => isHumanComment(c)).at(-1);
  if (latest && parseChatOps(latest.body).type === "cancel") return ops.cancel();
  if ((await overlapsOf(deps, config, issue.number, plannedFiles(issue))).length > 0) return "waiting";
  const build = Object.values(workflow.steps).find((s) => s.uses === "build");
  return build ? ops.build(build) : "waiting";
}
