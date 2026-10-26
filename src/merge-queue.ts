// The merge queue (spec 10 merge-serial): PRs green against an old main can break it together, so one
// lands at a time, rebased onto the latest main and gated in a clean checkout. A rebase that moves the
// head is pushed and merged on a later poll, once the merge policy passes on it; a red gate never merges.

import { rmSync } from "node:fs";
import { type GateResult, type GateRunner, runGates } from "./gates";
import type { FactoryConfig } from "./config";
import { postComment, type WatchDeps } from "./engine/common";
import type { Git } from "./git";
import type { GhIssue } from "./github";
import type { MergeDecision } from "./merge-policy";

export type LandResult =
  | { readonly outcome: "merged" | "requeued"; readonly head: string; readonly base: string }
  | {
      readonly outcome: "refused";
      readonly reason: "conflict" | "gate" | "push" | "main-moved";
      readonly detail: string;
    };

export interface LandPort {
  fetchBase(): Promise<string>;
  rebase(onto: string): Promise<{ ok: true; head: string } | { ok: false; detail: string }>;
  gate(head: string): Promise<GateResult>;
  push(expected: string): Promise<{ ok: boolean; detail: string }>;
  merge(head: string): Promise<void>;
  report(text: string): Promise<void>;
}

export const LAND_ROUNDS = 3;

const short = (sha: string) => sha.slice(0, 7);

export function mergeQueueMarker(head: string, base: string): string {
  return `<!-- factory:merge-queue:${head}:${base} -->`;
}

export async function land(port: LandPort, prHead: string, rounds = LAND_ROUNDS): Promise<LandResult> {
  let base = "";
  const say = (text: string) => port.report(`${mergeQueueMarker(prHead, base)}\nMerge queue: ${text}`);
  const refuse = async (reason: Extract<LandResult, { outcome: "refused" }>["reason"], detail: string) => {
    await say(`**not merged** (${reason}). ${detail}`);
    return { outcome: "refused", reason, detail } as const;
  };
  for (let round = 1; round <= rounds; round++) {
    base = await port.fetchBase();
    const rebased = await port.rebase(base);
    if (!rebased.ok) return refuse("conflict", `Rebasing onto main \`${short(base)}\` stopped:\n\n${rebased.detail}`);
    const gate = await port.gate(rebased.head);
    if (gate.status !== "GREEN")
      return refuse("gate", `Rebased onto main \`${short(base)}\`, the gate is ${gate.status}:\n\n${gate.raw}`);
    if (rebased.head !== prHead) {
      const push = await port.push(prHead);
      if (!push.ok) return refuse("push", `Pushing the rebased branch failed:\n\n${push.detail}`);
      // Never merged in the pass that pushed: CI, protected paths and changed files are judged again on it.
      await say(
        `rebased onto main \`${short(base)}\` and pushed \`${short(rebased.head)}\`; it merges once the merge policy passes on that commit.`,
      );
      return { outcome: "requeued", head: rebased.head, base };
    }
    if ((await port.fetchBase()) !== base) continue;
    await port.merge(prHead);
    return { outcome: "merged", head: prHead, base };
  }
  return refuse("main-moved", `Main moved during each of ${rounds} rounds; the next poll tries again.`);
}

// One land at a time in this process: each waits for the one before it, whatever that one's outcome.
export class MergeQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export const mergeQueue = new MergeQueue();

export interface GitLandInput {
  readonly git: Git;
  readonly gateRunner: GateRunner;
  readonly worktree: string;
  readonly base: string;
  readonly branch: string;
  readonly merge: (head: string) => Promise<void>;
  readonly report: (text: string) => Promise<void>;
}

export function gitLandPort(i: GitLandInput, prHead: string): LandPort {
  return {
    fetchBase: () => i.git.fetchBase(i.worktree, i.base),
    rebase: (onto) => i.git.rebaseOnto(i.worktree, onto, prHead),
    // The worktree is the agent's and untrusted: the gate sees only the committed, rebased head.
    gate: async (head) => {
      const room = i.git.cleanCheckout(i.worktree, head);
      try {
        return await runGates(i.gateRunner, room);
      } finally {
        rmSync(room, { recursive: true, force: true });
      }
    },
    push: async (expected) => {
      const r = await i.git.pushRebased(i.worktree, i.branch, expected);
      return { ok: r.code === 0, detail: r.stderr.trim().slice(-500) };
    },
    merge: i.merge,
    report: i.report,
  };
}

// The watcher's way in: only a "merge" decision queues, and a refusal is reported once per head and base.
export async function landInQueue(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  prNumber: number,
  decision: MergeDecision,
  worktree: string,
): Promise<LandResult | undefined> {
  if (decision.outcome !== "merge") return undefined;
  const input: GitLandInput = {
    git: deps.git,
    gateRunner: deps.gateRunner,
    worktree,
    base: config.base,
    branch: deps.git.branchName(issue.number),
    merge: (head) => deps.github.mergePr(config.repo, prNumber, head),
    report: async (text) => {
      const marker = text.split("\n")[0]!;
      if (!issue.comments.some((c) => c.body.includes(marker))) await postComment(deps, config, issue.number, text);
    },
  };
  return mergeQueue.run(() => land(gitLandPort(input, decision.headSha), decision.headSha));
}
