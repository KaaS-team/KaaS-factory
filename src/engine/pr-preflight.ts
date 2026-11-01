// Checked before the paid pr agent runs: the PR must point at the verified commit, and a plan
// that flags a boundary change needs its decision record. Returns the refusal, or undefined.
import type { FactoryConfig } from "../config";
import { boundaryRecordMissing } from "../boundary-record";
import type { PlanArtifact } from "../artifacts";
import type { WatchDeps } from "./common";
import { readRunJson } from "./verdict-rules";

export async function prPreflight(
  deps: WatchDeps,
  config: FactoryConfig,
  worktree: string,
  issueNumber: number,
): Promise<string | undefined> {
  let remote: string | undefined;
  try {
    remote = await deps.git.remoteHeadSha(worktree, issueNumber);
  } catch (err) {
    return `pr_remote_unreachable: ${(err as Error).message}`;
  }
  if ((await deps.git.headSha(worktree)) !== remote)
    return "pr_head_mismatch: the remote branch is not the verified commit";
  if (!(await deps.git.hasCommits(worktree, config.base))) return "pr_empty: the branch has no commits over base";
  return boundaryRecordMissing(
    readRunJson<PlanArtifact>(worktree, issueNumber, "plan.json"),
    await deps.git.changedFiles(worktree, config.base),
  );
}
