// Serialises issues that plan to change the same files: two builds on one file make the later PR
// conflict and get rebuilt. The check runs where a plan becomes a build (the earliest point the
// files are known), and the later issue waits under LABEL.overlap until the earlier ones leave flight.

import type { FactoryConfig } from "./config";
import { isTrusted } from "./chatops";
import { latestDataFor, parseDataMarkers } from "./derive";
import { finish, moveLabel, postComment, type WatchDeps } from "./engine/common";
import type { GhIssue } from "./github";
import { LABEL } from "./labels";

export interface Planned {
  readonly issue: number;
  readonly files: readonly string[];
}

export interface Overlap {
  readonly issue: number;
  readonly shared: readonly string[];
}

// Only a lower-numbered issue can block, so two overlapping issues never wait on each other.
export function overlapping(self: Planned, inFlight: readonly Planned[]): Overlap[] {
  const mine = new Set(self.files);
  return inFlight
    .filter((o) => o.issue < self.issue)
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

// Issues past their plan that have not left flight: building, verifying, in review, or themselves waiting.
async function inFlightPlans(deps: WatchDeps, config: FactoryConfig, self: number): Promise<Planned[]> {
  const labels = [LABEL.building, LABEL.verifying, LABEL.inReview, LABEL.overlap];
  const lists = await Promise.all(labels.map((l) => deps.github.listIssuesByLabel(config.repo, l)));
  const seen = new Map(lists.flat().map((i) => [i.number, i]));
  seen.delete(self);
  return [...seen.values()].map((i) => ({ issue: i.number, files: plannedFiles(i) }));
}

export async function overlapsOf(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: number,
  files: readonly string[],
): Promise<Overlap[]> {
  return overlapping({ issue, files }, await inFlightPlans(deps, config, issue));
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
