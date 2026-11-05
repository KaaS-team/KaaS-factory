// A stage whose JSON is present but invalid gets one more run that is shown every problem at once,
// then hard-fails with the whole list as its cause (docs/decisions: none needed, no threshold changes).

import { readStageArtifacts, stepProblems } from "../artifacts";
import { typesFor } from "../labels";
import type { StageRunResult } from "../ports/agent";
import { runStage, stageJson, type StepStage } from "./common";
import type { StepCtx } from "./steps";

export type StageRunExtra = Parameters<typeof runStage>[5];

export interface CheckedStage<T> {
  readonly result: StageRunResult;
  readonly art: Awaited<ReturnType<typeof readStageArtifacts>>;
  readonly json?: T;
  // Every problem of the last attempt joined, for stageCause.
  readonly problem?: string;
}

export async function runStageChecked<T extends { outcome?: "complete" | "blocked" | "failed"; summary?: string }>(
  { deps, config, issue, worktree }: Pick<StepCtx, "deps" | "config" | "issue" | "worktree">,
  stage: StepStage,
  extra: StageRunExtra,
): Promise<CheckedStage<T>> {
  const types = typesFor(config.routes);
  let opts = extra;
  for (let attempt = 0; ; attempt++) {
    const result = await runStage(deps, config, issue, stage, worktree, opts);
    const art = await readStageArtifacts(worktree, issue.number, stage);
    const problems = art.json === undefined || result.exitCode !== 0 ? [] : stepProblems(stage, art.json, types);
    if (problems.length === 0) return { result, art, ...stageJson<T>(stage, art.json, types) };
    if (attempt === 1) return { result, art, problem: problems.join("; ") };
    const sessionId = deps.state.lastSession(config.repo, issue.number, stage)?.session_id;
    const failure = `${stage}.json failed validation:\n${problems.map((p) => `- ${p}`).join("\n")}`;
    opts = { ...extra, resume: { ...(sessionId ? { sessionId } : {}), failure } };
  }
}

// A rebuild is told why it came back, any agent; it forks the build session only if one was kept.
export function rebuildFrom(sc: StepCtx): { resume?: { sessionId?: string; failure: string } } {
  const failure = sc.ctx.failure;
  delete sc.ctx.failure;
  const id =
    failure === undefined ? "" : sc.deps.state.lastSession(sc.config.repo, sc.issue.number, "build")?.session_id;
  return failure !== undefined ? { resume: { ...(id ? { sessionId: id } : {}), failure } } : {};
}
