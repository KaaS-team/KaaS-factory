// Backport a merged PR to release branches: the plan is pure data, the runner is thin over a CommandRunner.
import { FALLBACK_IDENTITY } from "./git";
import type { CommandRunner } from "./github";

export type GitStep = readonly string[];
export interface BackportPlan {
  readonly branch: string;
  readonly work: string;
  readonly steps: readonly GitStep[];
}
export type BackportResult = { readonly branch: string; readonly outcome: "pushed" | "conflict" | "failed" };

const LABEL = /^backport:(.+)$/;
// A leading dash would read as a git option; the character set is what git accepts for plain branch names.
const SAFE_BRANCH = /^(?!-)[A-Za-z0-9._/-]+$/;

export function backportTargets(labels: readonly string[], base: string): string[] {
  const out = new Set<string>();
  for (const l of labels) {
    const b = LABEL.exec(l)?.[1]?.trim();
    if (b && b !== base && SAFE_BRANCH.test(b) && !b.includes("..")) out.add(b);
  }
  return [...out];
}

export function planBackport(input: {
  readonly sha: string;
  readonly pr: number;
  readonly parents: number;
  readonly branches: readonly string[];
}): BackportPlan[] {
  const { sha, pr, parents } = input;
  return input.branches.map((branch) => {
    const work = `backport/${pr}-${branch.replaceAll("/", "-")}`;
    return {
      branch,
      work,
      steps: [
        ["fetch", "origin", branch],
        ["switch", "-C", work, `origin/${branch}`],
        ["cherry-pick", "-x", ...(parents > 1 ? ["-m", "1"] : []), sha],
        ["push", "origin", `${work}:${work}`],
      ],
    };
  });
}

export async function runBackport(
  plans: readonly BackportPlan[],
  runner: CommandRunner,
  cwd: string,
): Promise<BackportResult[]> {
  const results: BackportResult[] = [];
  // cherry-pick commits, and a bare runner has no identity to commit with.
  const known = (await runner.run(["config", "user.email"], { cwd })).stdout.trim() !== "";
  for (const plan of plans) {
    let outcome: BackportResult["outcome"] = "pushed";
    for (const step of plan.steps) {
      const res = await runner.run(step[0] === "cherry-pick" && !known ? [...FALLBACK_IDENTITY, ...step] : [...step], {
        cwd,
      });
      if (res.code === 0) continue;
      const pick = step.includes("cherry-pick");
      if (pick) await runner.run(["cherry-pick", "--abort"], { cwd });
      outcome = pick ? "conflict" : "failed";
      break;
    }
    results.push({ branch: plan.branch, outcome });
  }
  return results;
}
