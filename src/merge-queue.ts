// One merge at a time per repo. Two green PRs that each pass alone can break main together, so
// the queue holds a lease, rebases the PR onto the latest base, and merges only a head that was
// re-gated after that rebase. A head the rebase moved waits for its gates on the next poll.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface Lease {
  acquire(repo: string): boolean;
  release(repo: string): void;
}

// mkdir is atomic, so two runner processes on one host cannot both hold a repo's lease.
export class DirLease implements Lease {
  constructor(private readonly root: string) {}
  private dir = (repo: string) => join(this.root, `${repo.replaceAll("/", "__")}.merge-lock`);
  acquire(repo: string): boolean {
    try {
      mkdirSync(this.root, { recursive: true });
      mkdirSync(this.dir(repo));
      return true;
    } catch {
      return false;
    }
  }
  release(repo: string): void {
    rmSync(this.dir(repo), { recursive: true, force: true });
  }
}

export interface QueueSteps {
  // The PR's head after rebasing onto the latest base: unchanged when it was already on top.
  rebase(): Promise<string>;
  // Whether the gates passed on exactly this head.
  gated(head: string): Promise<boolean>;
  merge(head: string): Promise<void>;
}

export type QueueOutcome = "merged" | "busy" | "rebased" | "not-gated";

export async function serialMerge(
  lease: Lease,
  repo: string,
  headSha: string,
  steps: QueueSteps,
): Promise<QueueOutcome> {
  if (!lease.acquire(repo)) return "busy";
  try {
    const head = await steps.rebase();
    if (head !== headSha) return "rebased";
    if (!(await steps.gated(head))) return "not-gated";
    await steps.merge(head);
    return "merged";
  } finally {
    lease.release(repo);
  }
}
