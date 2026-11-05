// Shared end of the build step: protected-path check, gate evidence, push.

import { hiddenPaths } from "../acceptance";
import { writeGateEvidence } from "../artifacts";
import { touchesProtectedPath } from "../boundary";
import { pushPolicy } from "../config-merge";
import { LABEL } from "../labels";
import { ShellSetupRunner } from "../setup";
import { finish, moveLabel, type Outcome } from "./common";
import { failPush } from "./failure";
import type { StepCtx, StepResult } from "./steps";

const stop = (outcome: Outcome): StepResult => ({ kind: "stop", outcome });

export async function finishBuild(
  sc: StepCtx,
  gate: { raw: string; status: string },
  facts: unknown,
): Promise<StepResult> {
  const { deps, config, issue, worktree, step } = sc;
  const issueNumber = issue.number;

  const changed = await deps.git.changedFiles(worktree, config.base);
  const protectedPaths = [
    ...config.protectedPaths,
    ...(await hiddenPaths(deps.setupRunner ?? new ShellSetupRunner(), config, worktree)),
  ];
  const baseFiles = await deps.git.baseFiles(worktree, config.base);
  const hits = touchesProtectedPath(changed, protectedPaths, { baseFiles });
  if (hits.length) {
    await moveLabel(deps, config, issueNumber, step.label, LABEL.needsHuman);
    finish(deps, config, issueNumber, "needs-human", `touched protected path(s): ${hits.join(", ")}`);
    return stop("needs-human");
  }

  deps.state.updateRun(config.repo, issueNumber, { gate_line: gate.raw });
  await writeGateEvidence(worktree, issueNumber, {
    line: gate.raw,
    status: gate.status,
    tree: await deps.git.treeHash(worktree),
  });
  // With policy.push "agent" the agent already pushed; a second push is the runner holding a right it gave away.
  const pushed = pushPolicy(config) === "agent" ? { code: 0, stderr: "" } : await deps.git.push(worktree, issueNumber);
  if (pushed.code !== 0) return stop(await failPush(deps, config, issue, step.label, worktree, pushed.stderr));
  return { kind: "next", facts };
}
