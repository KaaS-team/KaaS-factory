// Shadow mode (`factory watch --shadow`): triage, plan, build and verify an issue in a throwaway detached
// worktree and post what the factory would do, without a claim commit, a branch, a push or a PR.
// The build's commit stays in that worktree, and verify judges the diff it holds.

import { runDir } from "./artifacts";
import { type Outcome, postComment, type WatchDeps } from "./engine/common";
import { ALL_STEP_TYPES as STEP_TYPES } from "./engine/registry";
import type { FactoryConfig } from "./config";
import type { Step, Workflow } from "./core/workflow";
import type { GhIssue } from "./github";
import { LABEL } from "./labels";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const SHADOW_STAGE = "shadow";

const stepUsing = (workflow: Workflow, uses: string): Step | undefined =>
  Object.values(workflow.steps).find((s) => s.uses === uses);

export async function processShadowIssue(
  issue: GhIssue,
  deps: WatchDeps,
  config: FactoryConfig,
  workflow: Workflow,
): Promise<Outcome> {
  const worktree = `${deps.workspacesDir}/issue-${issue.number}`;
  let pushesRefused = 0;
  // The one outbound write a build makes is its push; every other git call stays inside the worktree.
  const git = new Proxy(deps.git, {
    get(target, key) {
      if (key === "push" || key === "pushBranch")
        return async () => {
          pushesRefused += 1;
          return { code: 0, stdout: "", stderr: "" };
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  deps = { ...deps, git };
  await deps.git.ensureDetachedWorktree(deps.cloneDir, worktree, config.base);
  mkdirSync(join(worktree, runDir(issue.number)), { recursive: true });
  const ctx = { rejectRound: 0, questionRound: 0 };
  const seen: string[] = [];
  let outcome: Outcome = "waiting";
  let rejected = false;
  for (const uses of ["triage", "plan", "build", "verify"]) {
    const step = stepUsing(workflow, uses);
    if (!step) continue;
    const result = await STEP_TYPES[uses]!.run({ deps, config, issue, worktree, ctx, step, workflow });
    seen.push(uses);
    if (result.kind === "stop") {
      outcome = result.outcome;
      break;
    }
    if (result.kind === "reject") {
      outcome = "waiting";
      rejected = true;
      break;
    }
  }
  await deps.git.removeWorktree(deps.cloneDir, worktree).catch(() => undefined);
  await postComment(
    deps,
    config,
    issue.number,
    `Shadow run: the factory ran ${seen.join(", ")} on this issue${rejected ? " and verify sent the build back" : ""}. The build lived in a throwaway worktree and was discarded: no branch, push or pull request was made. Remove \`--shadow\` from the watcher and label the issue \`${LABEL.ready}\` again to run it for real.`,
    { stage: SHADOW_STAGE, json: { ran: seen, outcome, rejected, pushesRefused } },
  );
  await deps.github.removeLabels(config.repo, issue.number, [LABEL.ready]);
  return outcome;
}
