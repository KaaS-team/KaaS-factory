// delivery.stack "task": build cuts one branch per planned task, and the pr stage opens one draft PR per
// task, each based on the one before. On a re-entry it also retargets after a lower merge and carries a
// fix on a lower slice up the stack, or parks naming the slice and files in conflict.

import type { FactoryConfig } from "../config";
import { carryUp, git, openStack, retargetAfterMerge, planStack, type StackedPr } from "../stacked-prs";
import type { PlanArtifact, TriageArtifact } from "../artifacts";
import { conventionalTitle, conventionalType, scopeOf, type EpicTask } from "./epic";
import { postRunDetails } from "./pr-body";
import type { StepCtx, StepResult } from "./steps";
import { readRunJson } from "./verdict-rules";
import { finish, moveLabel, postComment, type Outcome, type WatchDeps } from "./common";
import { LABEL } from "../labels";

// The slices of a run, or undefined when it ships as one PR (stack off, or fewer than two tasks).
export function stackOf(config: FactoryConfig, branch: string, tasks: readonly EpicTask[]): StackedPr[] | undefined {
  const plan = planStack(tasks, config.delivery.stack, branch, config.base);
  return plan.length > 1 ? plan : undefined;
}

// Build side: one branch per slice at its commit, pushed when the remote has none. Needs exactly one
// commit per task over the base; anything else leaves the run unsliced and drops stale slice branches.
export async function cutSlices(worktree: string, base: string, plan: readonly StackedPr[]): Promise<boolean> {
  const list = await git(worktree, "rev-list", "--reverse", `origin/${base}..HEAD`);
  const commits = list.code === 0 ? list.out.split("\n").filter(Boolean) : [];
  if (commits.length !== plan.length) {
    for (const slice of plan) await git(worktree, "branch", "-D", slice.branch);
    return false;
  }
  for (const [i, slice] of plan.entries()) {
    const sha = commits[i]!;
    if ((await git(worktree, "branch", "-f", slice.branch, sha)).code !== 0) return false;
    const remote = await git(worktree, "ls-remote", "--heads", "origin", slice.branch);
    if (remote.code === 0 && !remote.out) {
      const push = await git(worktree, "push", "--no-verify", "origin", `${sha}:refs/heads/${slice.branch}`);
      if (push.code !== 0) return false;
    }
  }
  return true;
}

// True when every slice branch is a local branch: build cut them.
export async function slicesCut(worktree: string, plan: readonly StackedPr[]): Promise<boolean> {
  for (const slice of plan)
    if ((await git(worktree, "rev-parse", "--verify", "-q", `refs/heads/${slice.branch}`)).code !== 0) return false;
  return true;
}

async function park(
  deps: WatchDeps,
  config: FactoryConfig,
  issueNumber: number,
  label: string,
  reason: string,
): Promise<Outcome> {
  await postComment(deps, config, issueNumber, `The stack is parked: ${reason}`, {
    stage: "stack",
    json: { parked: true, reason },
  });
  await moveLabel(deps, config, issueNumber, label, LABEL.needsHuman);
  finish(deps, config, issueNumber, "needs-human", reason);
  return "needs-human";
}

export interface StackRun {
  readonly deps: WatchDeps;
  readonly config: FactoryConfig;
  readonly issueNumber: number;
  readonly label: string;
  readonly worktree: string;
  readonly plan: readonly StackedPr[];
  readonly tasks: readonly EpicTask[];
  readonly type: string;
  readonly finalBody: string; // the pr agent's body: it closes the issue, so only the top slice gets it
}

// Opens or updates the stack. Returns the parked outcome, or the open slices' URLs (bottom first).
export async function deliverStack(run: StackRun): Promise<{ parked: Outcome } | { urls: string[]; heads: string[] }> {
  const { deps, config, issueNumber, worktree, label } = run;
  const github = deps.github;
  const host = {
    findPrByHead: (repo: string, head: string) => github.findPrByHead(repo, head),
    retargetPr: async (repo: string, n: number, base: string) => void (await github.retargetPr?.(repo, n, base)),
  };
  let plan = [...run.plan];

  // A lower slice merged: rebase the next onto the base branch and move its PR base, then carry the rest.
  const merged: string[] = [];
  for (const slice of plan) {
    if (!(await github.mergedPrByHead(config.repo, slice.branch))) break;
    merged.push(slice.task);
  }
  if (merged.length && merged.length < plan.length) {
    const lower = plan[merged.length - 1]!;
    const next = plan[merged.length]!;
    const mergedHead = (await git(worktree, "rev-parse", lower.branch)).out;
    const nextOld = (await git(worktree, "rev-parse", next.branch)).out;
    const stale = (await git(worktree, "merge-base", "--is-ancestor", mergedHead, next.branch)).code === 0;
    if (stale) {
      const out = await retargetAfterMerge(host, worktree, config.repo, plan, merged, config.base, mergedHead);
      if (out.parked) return { parked: await park(deps, config, issueNumber, label, out.parked.reason) };
      const up = await carryUp(worktree, plan, next.task, nextOld);
      if (up.parked) return { parked: await park(deps, config, issueNumber, label, up.parked.reason) };
    } else {
      const open = await github.findPrByHead(config.repo, next.branch);
      if (open) await github.retargetPr?.(config.repo, open.number, config.base);
    }
    plan = plan.slice(merged.length).map((s, i) => (i === 0 ? { ...s, base: config.base, parent: undefined } : s));
  }

  // A fix committed on a lower slice since it was pushed: push it, then carry every slice above it.
  await git(worktree, "fetch", "--quiet", "origin");
  for (const slice of plan) {
    const pushed = (await git(worktree, "rev-parse", "--verify", "-q", `origin/${slice.branch}`)).out;
    const local = (await git(worktree, "rev-parse", slice.branch)).out;
    if (!pushed || pushed === local) continue;
    if ((await git(worktree, "merge-base", "--is-ancestor", pushed, local)).code !== 0) continue;
    const push = await git(worktree, "push", "--no-verify", "origin", `${slice.branch}:${slice.branch}`);
    if (push.code !== 0)
      return { parked: await park(deps, config, issueNumber, label, `push of ${slice.branch} was refused`) };
    const up = await carryUp(worktree, plan, slice.task, pushed);
    if (up.parked) return { parked: await park(deps, config, issueNumber, label, up.parked.reason) };
    break;
  }

  const last = plan[plan.length - 1]!.task;
  const type = run.type;
  const urls = await openStack(github, config.repo, plan, (slice, i) => {
    const task = run.tasks.find((t) => t.id === slice.task);
    const title = conventionalTitle(type, scopeOf(task?.files ?? []), task?.title ?? slice.task, `#${issueNumber}`);
    if (slice.task === last) return { title, body: run.finalBody };
    return {
      title,
      body: `Slice ${i + 1} of ${plan.length} for #${issueNumber}. Based on \`${slice.base}\`; merge the slices in order.\n\nRefs #${issueNumber}`,
    };
  });
  return { urls: plan.map((s) => urls.get(s.task)!), heads: plan.map((s) => s.branch) };
}

export async function cutBuildSlices(
  config: FactoryConfig,
  worktree: string,
  branch: string,
  tasks: readonly EpicTask[],
): Promise<void> {
  const slices = stackOf(config, branch, tasks);
  if (slices) await cutSlices(worktree, config.base, slices);
}

// The pr step for a stacked run, or undefined when the run ships as one PR.
export async function shipStack(
  sc: StepCtx,
  head: string,
  comment: string | undefined,
  receipt: string,
): Promise<StepResult | undefined> {
  const { deps, config, issue, worktree } = sc;
  const planned = readRunJson<PlanArtifact>(worktree, issue.number, "plan.json");
  const slices = stackOf(config, head, planned?.tasks ?? []);
  if (!slices || !(await slicesCut(worktree, slices))) return undefined;
  const out = await deliverStack({
    deps,
    config,
    issueNumber: issue.number,
    label: sc.step.label,
    worktree,
    plan: slices,
    tasks: planned?.tasks ?? [],
    type: conventionalType(readRunJson<TriageArtifact>(worktree, issue.number, "triage.json")?.type),
    finalBody: comment ?? `Closes #${issue.number}`,
  });
  if ("parked" in out) return { kind: "stop", outcome: out.parked };
  await postRunDetails(deps, config, issue.number, receipt);
  for (const h of out.heads) await deps.github.markReady(config.repo, h, true);
  deps.state.updateRun(config.repo, issue.number, { pr_url: out.urls[0]! });
  finish(deps, config, issue.number, "shipped");
  return { kind: "stop", outcome: "shipped" };
}
