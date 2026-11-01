// A workflow with no plan step never writes plan.json, so the build skill has to build from the
// triage handoff there. This reads the shipped skill's text and says whether it does.

import type { Workflow } from "../core/workflow";

export function hasPlanStep(workflow: Workflow): boolean {
  return Object.values(workflow.steps).some((s) => s.uses === "plan");
}

// The skill must name the fallback input and say it replaces the plan; "stop" alone is the bug.
export function planlessBuildProblems(buildSkill: string): string[] {
  const problems: string[] = [];
  if (!/`plan\.json` is absent/.test(buildSkill)) problems.push("build skill has no rule for an absent plan.json");
  if (!/`done_when`/.test(buildSkill)) problems.push("build skill does not build from triage.json's done_when");
  if (!/`files_expected`/.test(buildSkill)) problems.push("build skill does not use triage.json's files_expected");
  return problems;
}
