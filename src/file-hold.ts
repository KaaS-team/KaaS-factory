// An approved plan waits while an issue already building, verifying or in review names any of its
// files, and starts once that issue merges. Its own file because watch.ts is frozen at its quality baseline.

import { isTrusted } from "./chatops";
import type { FactoryConfig } from "./config";
import { latestDataFor, parseDataMarkers } from "./derive";
import { postComment, type WatchDeps } from "./engine/common";
import type { GhComment, GhIssue } from "./github";
import { LABEL } from "./labels";

export function findPlanComment(issue: GhIssue): GhComment | undefined {
  return [...issue.comments].reverse().find((c) => isTrusted(c) && c.body.includes("<!-- factory:plan v1"));
}

function planFilesOf(issue: GhIssue): string[] {
  const plan = findPlanComment(issue);
  const json = plan ? (latestDataFor(parseDataMarkers([plan]), "plan") as { files?: unknown } | undefined) : undefined;
  return Array.isArray(json?.files) ? json.files.filter((f): f is string => typeof f === "string") : [];
}

export interface FileHold {
  readonly number: number;
  readonly shared: readonly string[];
}

// The lowest-numbered issue whose plan names any of `files`, with the files they share (exact paths, NG-3).
export function fileHold(
  files: readonly string[],
  active: readonly { readonly number: number; readonly files: readonly string[] }[],
): FileHold | undefined {
  for (const other of [...active].sort((a, b) => a.number - b.number)) {
    const shared = files.filter((f) => other.files.includes(f));
    if (shared.length > 0) return { number: other.number, shared: [...new Set(shared)] };
  }
  return undefined;
}

// Serialises each approval's hold check and label write, so two approvals in one poll cannot both
// see the other as idle. Held through the claim (worktree setup, label write), never the build itself.
let holdChain: Promise<unknown> = Promise.resolve();

function withHoldLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = holdChain.then(fn);
  holdChain = next.catch(() => undefined);
  return next;
}

// Issues whose plan is being built, verified or in review, each with the files its plan names.
async function activeFileHolders(deps: WatchDeps, config: FactoryConfig, self: number) {
  const lists = await Promise.all(
    [LABEL.building, LABEL.verifying, LABEL.inReview].map((l) => deps.github.listIssuesByLabel(config.repo, l)),
  );
  return lists
    .flat()
    .filter((i) => i.number !== self)
    .map((i) => ({ number: i.number, files: planFilesOf(i) }));
}

// "held" when another issue names one of the plan's files. Otherwise `claim` runs inside the lock, so the
// next approval sees its label; it returns whether the start went ahead (false: setup failed).
export async function holdForFiles(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  claim: () => Promise<boolean>,
): Promise<"held" | boolean> {
  return withHoldLock(async () => {
    const hold = fileHold(planFilesOf(issue), await activeFileHolders(deps, config, issue.number));
    if (!hold) return claim();
    // Once per holder: the hidden marker is what later polls read back.
    const marker = `<!-- factory:hold v1 for=#${hold.number} -->`;
    if (!issue.comments.some((c) => c.body.includes(marker)))
      await postComment(
        deps,
        config,
        issue.number,
        `waits for #${hold.number}, same files: ${hold.shared.join(", ")}. It starts once #${hold.number} merges.\n\n${marker}`,
      );
    return "held";
  });
}
