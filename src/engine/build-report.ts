// Two #636 rules the steps call: a build report that skips its goal or checkpoints goes back to build,
// and an issue with no acceptance lines is refused at plan.
import type { BuildArtifact, PlanArtifact } from "../artifacts";
import { acceptanceLines, NO_ACCEPTANCE_LINE, reportProblems, rowsFrom } from "../goal";
import { postComment, stopStep } from "./common";
import type { StepCtx, StepResult } from "./steps";
import { readRunJson } from "./verdict-rules";

// The build prompt carries a goal only when the plan has criteria, so only then is a missing report an omission.
export function incompleteReport(
  worktree: string,
  issue: number,
): { body: string; json: object; why: string } | undefined {
  const report = readRunJson<BuildArtifact>(worktree, issue, "build.json");
  const goal = rowsFrom(readRunJson<PlanArtifact>(worktree, issue, "plan.json"));
  const missing =
    report && goal.length > 0
      ? reportProblems(
          report,
          goal.map((r) => r.id),
        )
      : [];
  if (missing.length === 0) return undefined;
  return {
    body: `The build report is incomplete:\n\n${missing.map((m) => `- ${m}`).join("\n")}`,
    json: { buildReport: missing },
    why: "the build report skipped its goal or checkpoints",
  };
}

export async function refuseNoAcceptance(sc: StepCtx): Promise<StepResult | undefined> {
  const { deps, config, issue, step } = sc;
  if (acceptanceLines(issue.body ?? "").length > 0) return undefined;
  await postComment(deps, config, issue.number, NO_ACCEPTANCE_LINE);
  const outcome = await stopStep(deps, config, issue.number, step.label, {
    status: "needs-human",
    reason: NO_ACCEPTANCE_LINE,
  });
  return { kind: "stop", outcome };
}
