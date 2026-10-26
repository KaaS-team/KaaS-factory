// After a merge the factory watches the live app: a failing smoke opens a revert PR instead of
// waiting for a person to notice, and the change failure rate across recent merges tightens how
// much the factory may merge alone (DORA's change failure rate; past 15% and 30% it backs off).

import type { Autonomy } from "./autonomy";
import type { MergeConfig } from "./config";

export interface RevertSteps {
  smoke(): Promise<boolean>;
  // Opens a PR that reverts `sha` and returns its URL.
  openRevert(sha: string, why: string): Promise<string>;
}

export async function watchAfterMerge(sha: string, steps: RevertSteps): Promise<{ ok: boolean; revert?: string }> {
  if (await steps.smoke()) return { ok: true };
  return { ok: false, revert: await steps.openRevert(sha, "the live smoke failed after merge") };
}

export const CFR_TIGHTEN = 0.15;
export const CFR_SUPERVISE = 0.3;

export function changeFailureRate(history: readonly { reverted: boolean }[]): number {
  return history.length ? history.filter((h) => h.reverted).length / history.length : 0;
}

type Limits = Pick<MergeConfig, "maxFiles" | "maxLines">;

// Past CFR_TIGHTEN the size limits halve; past CFR_SUPERVISE the repo drops to supervised.
export function tightenThresholds(limits: Limits, mode: Autonomy, cfr: number): { limits: Limits; mode: Autonomy } {
  if (cfr > CFR_SUPERVISE) return { limits, mode: "supervised" };
  if (cfr > CFR_TIGHTEN)
    return {
      limits: {
        maxFiles: Math.max(1, Math.floor(limits.maxFiles / 2)),
        maxLines: Math.max(1, Math.floor(limits.maxLines / 2)),
      },
      mode,
    };
  return { limits, mode };
}

// The revert itself, in a clone: `git revert --no-edit` then push a branch the PR is opened from.
export async function revertBranch(cwd: string, sha: string): Promise<string> {
  const branch = `factory/revert-${sha.slice(0, 7)}`;
  for (const args of [
    ["checkout", "-B", branch],
    ["revert", "--no-edit", sha],
  ]) {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
    if ((await p.exited) !== 0) throw new Error(`git ${args[0]}: ${(await new Response(p.stderr).text()).trim()}`);
  }
  return branch;
}
