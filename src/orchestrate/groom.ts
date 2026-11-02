// Planning groom: a maintainer-tagged issue gets a read-only plan stage draft, guardPlan, then a planned body.

import { resolveAgent } from "../agents/executor";
import { issueFiles } from "../area-locks";
import type { FactoryConfig } from "../config";
import type { GhIssue } from "../github";
import { LABEL } from "../labels";
import { orchestrateOf } from "./config";
import { checklist, childIssues, closingLine } from "../engine/epic";
import { isPlannedBody, PLANNED_MARKER } from "../engine/import-plan";
import { minionOutput } from "../engine/minion";
import { postComment, type WatchDeps } from "../engine/common";
import { guardPlan } from "../plan-guard";
import { sliceBacklog, type BacklogItem } from "../plan-slice";
import { TRUSTED_ROLES } from "../ports/scm";
import { cachedRole } from "../trust";

export type GroomDeps = Pick<WatchDeps, "github" | "executor" | "state" | "cloneDir">;

type IssueSlice = { number: number; title: string; body: string };

function sizeMinutes(labels: readonly { name: string }[]): number {
  for (const l of labels) {
    if (l.name === "size:S") return 30;
    if (l.name === "size:M") return 60;
    if (l.name === "size:L") return 120;
  }
  return 30;
}

function taskIssueNumber(taskId: string): number {
  const base = taskId.split("#")[0]!;
  return Number(base);
}

function unitIssueNumbers(unit: { tasks: readonly string[] }): number[] {
  return unit.tasks.map((t) => taskIssueNumber(t));
}

function draftBody(finalMessage: string | undefined): string {
  if (finalMessage === undefined) return "";
  const parsed = minionOutput("", finalMessage);
  return typeof parsed === "string" ? parsed : finalMessage;
}

export function groomPrompt(
  issue: { number: number; title: string; body: string },
  children: readonly IssueSlice[],
): string {
  const childBlock =
    children.length === 0
      ? ""
      : [
          "This issue is an epic checklist. Write one planned body for the whole epic in a single pull request.",
          `Use this closing line in the plan: ${closingLine(
            issue.number,
            children.map((c) => c.number),
          )}`,
          "",
          "Child issues:",
          ...children.flatMap((c) => [`### #${c.number}: ${c.title}`, c.body.trim(), ""]),
        ].join("\n");

  return [
    "Write exactly one planned issue body for the factory. Answer with the body only, no preamble or fence.",
    "Read the repository for context but change nothing on disk.",
    "Keep the work to one pull request.",
    "",
    `The body must start with ${PLANNED_MARKER} and include these markdown headings exactly: ## Why, ## Change, ## Tests, ## Acceptance, ## Files.`,
    "Under ## Files list every path the build will touch, one per line with backticks.",
    "Include a ## Risk: line (low, medium, or high).",
    "",
    `# Issue #${issue.number}: ${issue.title}`,
    issue.body.trim(),
    childBlock,
  ].join("\n");
}

async function park(
  deps: GroomDeps,
  config: FactoryConfig,
  issueNumber: number,
  groomLabel: string,
  comment: string,
): Promise<"parked"> {
  await deps.github.addLabels(config.repo, issueNumber, [LABEL.needsHuman]);
  await deps.github.removeLabels(config.repo, issueNumber, [groomLabel]);
  await postComment(deps as WatchDeps, config, issueNumber, comment);
  return "parked";
}

export async function groomIssue(
  deps: GroomDeps,
  config: FactoryConfig,
  issue: GhIssue,
): Promise<"groomed" | "parked" | "skipped"> {
  const { groom, roles, cost } = orchestrateOf(config);
  const n = issue.number;

  if (deps.github.editIssueBody === undefined) return "skipped";

  const by = await deps.github.labeledBy(config.repo, n, groom.label);
  const role = by ? await cachedRole(deps.github, config.repo, by) : "none";
  if (!TRUSTED_ROLES.includes(role)) {
    await deps.github.removeLabels(config.repo, n, [groom.label]);
    await postComment(
      deps as WatchDeps,
      config,
      n,
      `\`${groom.label}\` was removed: ${by ? `@${by} has the ${role} role here` : "the issue history does not say who applied it"}, and the factory starts only for people with write access or higher. A maintainer can add the label again to start it.`,
    );
    return "skipped";
  }

  const groomAgent = roles.groom.trim();
  if (groomAgent && !Object.hasOwn(config.agents, groomAgent)) {
    return park(deps, config, n, groom.label, "The planning agent named in the factory config does not exist.");
  }

  let children: IssueSlice[] = [];
  if (checklist(issue.body).length > 0) {
    const nums = childIssues(issue.body, n);
    const loaded = await Promise.all(nums.map(async (num) => deps.github.getIssue(config.repo, num)));
    const items: BacklogItem[] = loaded.map((child, i, arr) => ({
      id: String(child.number),
      deps: i === 0 ? [] : [String(arr[i - 1]!.number)],
      files: issueFiles(child),
      minutes: sizeMinutes(child.labels),
    }));
    const units = sliceBacklog(items, groom.epicMinutes);
    if (units.length > 1) {
      const lines = units.map(
        (u, i) =>
          `Unit ${i + 1}: ${unitIssueNumbers(u)
            .map((x) => `#${x}`)
            .join(", ")}`,
      );
      return park(deps, config, n, groom.label, `This epic is too large for one pull request. ${lines.join("; ")}`);
    }
    children = loaded.map((c) => ({ number: c.number, title: c.title, body: c.body }));
  }

  const agentName = groomAgent || resolveAgent(config.agents, config.stages, "plan").name;
  const run = await deps.executor.runStage({
    stage: "plan",
    issue: n,
    cwd: deps.cloneDir,
    agent: agentName,
    model: groom.model,
    prompt: groomPrompt(issue, children),
    maxBudgetUsd: cost.perRunUsd,
  });

  const body = draftBody(run.finalMessage).trim();
  if (run.exitCode !== 0 || !body) {
    return park(
      deps,
      config,
      n,
      groom.label,
      "The plan could not be drafted. A maintainer can edit the issue and add the planning label again.",
    );
  }

  if (!isPlannedBody(body)) {
    return park(
      deps,
      config,
      n,
      groom.label,
      "The plan draft did not pass the plan check: The body does not start with the planned marker.",
    );
  }

  const guard = guardPlan(body, config);
  if (!guard.ok) {
    return park(
      deps,
      config,
      n,
      groom.label,
      `The plan draft did not pass the plan check: ${guard.reasons.join("; ")}`,
    );
  }

  await deps.github.editIssueBody!(config.repo, n, body);
  await deps.github.removeLabels(config.repo, n, [groom.label]);
  if (children.length > 0) {
    for (const child of children) {
      await postComment(
        deps as WatchDeps,
        config,
        child.number,
        `Planned as part of #${n}; it ships in that pull request.`,
      );
    }
  }
  await deps.github.addLabels(config.repo, n, [LABEL.ready]);
  return "groomed";
}
