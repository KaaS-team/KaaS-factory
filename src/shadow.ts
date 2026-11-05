// Shadow mode (`factory watch --shadow`): triage and plan an issue and post what the factory would do,
// without a claim commit, a branch or a PR. Nothing is built, so there is no code for verify to judge;
// the plan stage's own rubric and critic are the only checks that run.

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
  await deps.git.ensureDetachedWorktree(deps.cloneDir, worktree, config.base);
  mkdirSync(join(worktree, runDir(issue.number)), { recursive: true });
  const ctx = { rejectRound: 0, questionRound: 0 };
  const seen: string[] = [];
  let outcome: Outcome = "waiting";
  for (const uses of ["triage", "plan"]) {
    const step = stepUsing(workflow, uses);
    if (!step) continue;
    const result = await STEP_TYPES[uses]!.run({ deps, config, issue, worktree, ctx, step, workflow });
    seen.push(uses);
    if (result.kind === "stop") {
      outcome = result.outcome;
      break;
    }
  }
  await postComment(
    deps,
    config,
    issue.number,
    `Shadow run: the factory ran ${seen.join(" and ")} on this issue and stopped. No branch or pull request was made, and nothing was built or verified, so the plan above is the whole result. Remove \`--shadow\` from the watcher and label the issue \`${LABEL.ready}\` again to run it for real.`,
    { stage: SHADOW_STAGE, json: { ran: seen, outcome } },
  );
  await deps.github.removeLabels(config.repo, issue.number, [LABEL.ready]);
  return outcome;
}
