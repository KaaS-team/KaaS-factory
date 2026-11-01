// Area locks: an issue's Files list is the set of paths it will edit. A ready issue whose Files overlap
// a path held by a run in flight, or by an issue picked earlier this poll, is skipped for the next poll.
// A lock is the issue's own label (building, verifying, in review), so it frees when the PR merges or
// the run ends and a dead run cannot hold one past its label.

import type { FactoryConfig } from "./config";
import type { WatchDeps } from "./engine/common";
import { overlaps, specFiles } from "./batch-plan";
import type { GhIssue } from "./github";
import { LABEL } from "./labels";

export const LOCK_LABELS: readonly string[] = [LABEL.building, LABEL.verifying, LABEL.inReview];

export interface Locked {
  readonly issue: number;
  readonly heldBy: number;
}

// An issue with no Files list takes no lock and is never held, since it names nothing to compare.
export function issueFiles(issue: Pick<GhIssue, "body">): string[] {
  return specFiles(issue.body ?? "");
}

export function takeLocks<T extends Pick<GhIssue, "number" | "body">>(
  ready: readonly T[],
  held: readonly Pick<GhIssue, "number" | "body">[],
): { free: T[]; locked: Locked[] } {
  const taken = held.map((h) => ({ issue: h.number, files: issueFiles(h) }));
  const free: T[] = [];
  const locked: Locked[] = [];
  for (const issue of ready) {
    const files = issueFiles(issue);
    const holder =
      files.length === 0 ? undefined : taken.find((t) => t.issue !== issue.number && overlaps(files, t.files));
    if (holder) {
      locked.push({ issue: issue.number, heldBy: holder.issue });
    } else {
      free.push(issue);
      taken.push({ issue: issue.number, files });
    }
  }
  return { free, locked };
}

export async function unlockedReady(deps: WatchDeps, config: FactoryConfig, ready: GhIssue[]): Promise<GhIssue[]> {
  if (ready.length === 0) return ready;
  const lists = await Promise.all(LOCK_LABELS.map((l) => deps.github.listIssuesByLabel(config.repo, l)));
  return takeLocks(ready, lists.flat()).free;
}
