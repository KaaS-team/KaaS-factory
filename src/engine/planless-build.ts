// A workflow with no plan step never writes plan.json, so the build skill has to build from the
// triage handoff there. This reads the shipped skill's text and says whether it does.

import { targets, type Workflow } from "../core/workflow";

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

const INPUT_STEPS = new Set(["plan", "triage"]);

// Step ids reachable from `from` over every edge, `from` included.
function reach(workflow: Workflow, from: string): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const step = workflow.steps[queue.shift()!];
    for (const [, t] of step ? targets(step) : [])
      if (!seen.has(t)) {
        seen.add(t);
        queue.push(t);
      }
  }
  return seen;
}

// A build step needs a plan or a triage step that the run passes before it; else build has no input.
export function buildInputProblems(workflow: Workflow): string[] {
  const fromStart = reach(workflow, workflow.start);
  const problems: string[] = [];
  for (const [id, step] of Object.entries(workflow.steps)) {
    if (step.uses !== "build") continue;
    const hasInput = Object.entries(workflow.steps).some(
      ([other, s]) => INPUT_STEPS.has(s.uses) && fromStart.has(other) && other !== id && reach(workflow, other).has(id),
    );
    if (!hasInput)
      problems.push(`${workflow.name}: build step "${id}" has no plan or triage step before it, so no input`);
  }
  return problems;
}
