// Which workflow an issue runs. Pickup records the one its type label's route names; an issue filed
// with no type label gets its type from triage, and that type's route switches it once, right
// after triage. A recorded choice never switches again, so a run cannot hop workflows mid-way.

import { isTrusted } from "../chatops";
import type { FactoryConfig } from "../config";
import type { Step, Workflow } from "../core/workflow";
import { parseDataMarkers } from "../derive";
import type { GhIssue } from "../github";
import { issueType } from "../labels";
import { labelsOf, withDataMarker, type WatchDeps } from "./common";
import { isPlannedBody, PLANNED_WORKFLOW } from "./import-plan";

export const WORKFLOW_MARKER = "workflow";

// The first choice a trusted comment recorded. Anyone can paste a marker into a comment, so an
// outsider's is ignored, and a later one never switches an issue (say, off a workflow that parks
// every plan) mid-run.
export function recordedWorkflow(issue: GhIssue): string | undefined {
  const marker = parseDataMarkers(issue.comments.filter(isTrusted)).find((m) => m.stage === WORKFLOW_MARKER);
  return (marker?.json as { name?: string } | undefined)?.name;
}

// A planned body carries its own plan, so it runs planned-to-pr whatever its type label says.
export function chosenWorkflow(config: FactoryConfig, issue: GhIssue): { name?: string; via: string } {
  if (isPlannedBody(issue.body ?? "")) return { name: PLANNED_WORKFLOW, via: "a planned issue" };
  const type = issueType(config.routes, labelsOf(issue));
  return { name: type ? config.routes[type]?.workflow : undefined, via: `\`routes.${type}.workflow\`` };
}

// The workflow triage's type routes to, and the step in it that stands where triage did.
export async function lateRoute(
  deps: Pick<WatchDeps, "github" | "routeWorkflows">,
  config: FactoryConfig,
  workflow: Workflow,
  issue: GhIssue,
  facts: unknown,
): Promise<{ workflow: Workflow; step: Step } | undefined> {
  const type = (facts as { type?: unknown } | undefined)?.type;
  if (typeof type !== "string" || issueType(config.routes, labelsOf(issue)) || recordedWorkflow(issue))
    return undefined;
  const name = config.routes[type]?.workflow;
  const target = name ? deps.routeWorkflows?.[name] : undefined;
  if (!target || target.name === workflow.name) return undefined;
  const step = Object.values(target.steps).find((s) => s.uses === "triage") ?? target.steps[target.start]!;
  const body = withDataMarker(`Running workflow \`${target.name}\` (triage typed it \`${type}\`).`, WORKFLOW_MARKER, {
    name: target.name,
  });
  await deps.github.commentIssue(config.repo, issue.number, body);
  return { workflow: target, step };
}
