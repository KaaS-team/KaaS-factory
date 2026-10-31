// delivery.stack "task": an epic ships as one PR per task, each based on the previous task's branch.
// Pure data: the plan says which branch and base each PR gets and when its base moves to the trunk.

import type { EpicTask } from "./engine/epic";

export type StackMode = "epic" | "task";

export interface StackedPr {
  readonly task: string;
  readonly branch: string;
  readonly base: string; // the parent's branch, or the epic base for the bottom PR
  readonly parent?: string; // the task id this PR waits on
}

export function planStack(
  tasks: readonly Pick<EpicTask, "id">[],
  mode: StackMode,
  epicBranch: string,
  epicBase: string,
): StackedPr[] {
  if (mode === "epic" || tasks.length < 2) return [{ task: epicBranch, branch: epicBranch, base: epicBase }];
  return tasks.map((t, i) => {
    const prev = i === 0 ? undefined : tasks[i - 1]!;
    return {
      task: t.id,
      branch: `${epicBranch}-${t.id}`,
      base: prev ? `${epicBranch}-${prev.id}` : epicBase,
      ...(prev ? { parent: prev.id } : {}),
    };
  });
}

// Merge bottom-up: the next PR to merge is the first whose parent is merged (or that has none).
// Once its parent merges, its base moves to the epic base, which is the rebase onto the trunk.
export function nextToMerge(
  plan: readonly StackedPr[],
  merged: readonly string[],
  epicBase: string,
): { pr: StackedPr; retarget: string } | undefined {
  const pr = plan.find((p) => !merged.includes(p.task) && (p.parent === undefined || merged.includes(p.parent)));
  return pr ? { pr, retarget: epicBase } : undefined;
}
