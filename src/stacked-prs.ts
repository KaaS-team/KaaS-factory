// delivery.stack "task": an epic ships as one PR per task, each based on the previous task's branch.
// Pure data: the plan says which branch and base each PR gets and when its base moves to the trunk.

import type { EpicTask } from "./engine/epic";
import type { CreatePrOptions, GhPr } from "./ports/scm";
import { syncRebase } from "./rebase-sync";

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

// ---- Acting on the plan: open the stack, retarget after a merge, carry a lower fix upward. ----

export interface StackHost {
  createPr(opts: CreatePrOptions): Promise<string>;
  findPrByHead(repo: string, head: string): Promise<Pick<GhPr, "number" | "url"> | undefined>;
  retargetPr(repo: string, number: number, base: string): Promise<void>;
}

// The run stops here and a human reads `reason`; it names the slice and the files in conflict.
export interface StackParked {
  readonly parked: true;
  readonly task: string;
  readonly reason: string;
}

export async function git(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: code === 0 ? out.trim() : err.trim() };
}

// One draft PR per slice, each on the previous slice's branch. A slice that already has a PR keeps it.
export async function openStack(
  host: Pick<StackHost, "createPr" | "findPrByHead">,
  repo: string,
  plan: readonly StackedPr[],
  describe: (pr: StackedPr, index: number) => { title: string; body: string },
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const [i, slice] of plan.entries()) {
    const existing = await host.findPrByHead(repo, slice.branch);
    const { title, body } = describe(slice, i);
    urls.set(
      slice.task,
      existing?.url ?? (await host.createPr({ repo, base: slice.base, head: slice.branch, title, body, draft: true })),
    );
  }
  return urls;
}

// Rebase `branch` from `oldBase` (the lower slice's head as it was) onto `onto`, then push it.
// A conflict that rebase-sync cannot settle aborts the rebase and parks, naming the files.
async function replant(
  worktree: string,
  task: string,
  branch: string,
  onto: string,
  oldBase: string,
): Promise<StackParked | undefined> {
  const co = await git(worktree, "checkout", "-q", branch);
  if (co.code !== 0) return { parked: true, task, reason: `slice ${task}: cannot check out ${branch}: ${co.out}` };
  const rb = await git(worktree, "rebase", "--onto", onto, oldBase, branch);
  if (rb.code !== 0 && !(await syncRebase(worktree))) {
    const files = (await git(worktree, "diff", "--name-only", "--diff-filter=U")).out.split("\n").filter(Boolean);
    await git(worktree, "rebase", "--abort");
    const named = files.length ? files.join(", ") : "no file listed";
    return { parked: true, task, reason: `slice ${task} (${branch}) conflicts when rebased onto ${onto}: ${named}` };
  }
  const push = await git(worktree, "push", "--no-verify", "--force-with-lease", "origin", `${branch}:${branch}`);
  if (push.code !== 0)
    return { parked: true, task, reason: `slice ${task}: push of ${branch} was refused: ${push.out}` };
  return undefined;
}

// The lower slice merged: rebase the next slice onto the base branch (dropping the merged slice's
// commits, which are the part below `mergedHead`), then move its PR base to the base branch.
export async function retargetAfterMerge(
  host: Pick<StackHost, "findPrByHead" | "retargetPr">,
  worktree: string,
  repo: string,
  plan: readonly StackedPr[],
  merged: readonly string[],
  epicBase: string,
  mergedHead: string,
): Promise<{ retargeted?: StackedPr; parked?: StackParked }> {
  const next = nextToMerge(plan, merged, epicBase);
  if (!next?.pr.parent) return {};
  await git(worktree, "fetch", "--quiet", "origin", epicBase);
  const parked = await replant(worktree, next.pr.task, next.pr.branch, `origin/${epicBase}`, mergedHead);
  if (parked) return { parked };
  const open = await host.findPrByHead(repo, next.pr.branch);
  if (open) await host.retargetPr(repo, open.number, next.retarget);
  return { retargeted: next.pr };
}

// A fix landed on `task`'s branch: every slice above it is rebased onto the new head, in order.
// `oldHead` is the lower branch's head before the fix. Stops at the first conflict.
export async function carryUp(
  worktree: string,
  plan: readonly StackedPr[],
  task: string,
  oldHead: string,
): Promise<{ carried: string[]; parked?: StackParked }> {
  const carried: string[] = [];
  let lower = plan.find((p) => p.task === task);
  let lowerOld = oldHead;
  while (lower) {
    const above = plan.find((p) => p.parent === lower!.task);
    if (!above) break;
    const before = (await git(worktree, "rev-parse", above.branch)).out;
    const parked = await replant(worktree, above.task, above.branch, lower.branch, lowerOld);
    if (parked) return { carried, parked };
    carried.push(above.task);
    lowerOld = before;
    lower = above;
  }
  return { carried };
}
