// The import-plan step: a planned issue's own plan stands in for the plan stage, so no agent runs.
// Four deterministic checks come first; a body that fails any of them parks with every problem.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runDir } from "../artifacts";
import type { FactoryConfig } from "../config";
import { LABEL } from "../labels";
import { floorPlanRisk } from "../risk";
import { finish, moveLabel, postComment } from "./common";
import { parsePlannedIssue, planFromIssue, type PlannedIssue } from "./import-plan";
import { proofAllowRules, planMustFix } from "./plan-critic";
import type { StepCtx, StepResult, StepType } from "./steps";

// The body is issue text, so a path that leaves the worktree must never reach the filesystem.
const outside = (worktree: string, p: string): boolean => {
  const rel = relative(resolve(worktree), resolve(worktree, p));
  return isAbsolute(p) || rel.startsWith("..") || isAbsolute(rel);
};

// Existing paths must exist and `(new)` ones must not, so a plan cannot name a file build cannot find.
export function fileProblems(plan: PlannedIssue, worktree: string): string[] {
  return plan.files.flatMap((f) => {
    if (outside(worktree, f.path)) return [`\`${f.path}\` is outside the repo.`];
    const there = existsSync(join(worktree, f.path));
    if (f.isNew && there) return [`\`${f.path}\` is marked (new) but already exists.`];
    if (!f.isNew && !there) return [`\`${f.path}\` does not exist; mark it (new) or fix the path.`];
    return [];
  });
}

// A mutation that cannot be applied would make verify reject a correct diff, so its find text must be in the file.
export function mutationProblems(plan: PlannedIssue, worktree: string): string[] {
  return plan.mutations.flatMap((m) => {
    if (outside(worktree, m.file)) return [`Mutation "${m.name}": \`${m.file}\` is outside the repo.`];
    const isNew = plan.files.some((f) => f.path === m.file && f.isNew);
    if (isNew) return [];
    const path = join(worktree, m.file);
    if (!existsSync(path)) return [`Mutation "${m.name}": \`${m.file}\` does not exist.`];
    return readFileSync(path, "utf8").includes(m.find)
      ? []
      : [`Mutation "${m.name}": its find text is not in \`${m.file}\`.`];
  });
}

export function importProblems(
  plan: PlannedIssue,
  comment: string,
  config: FactoryConfig,
  issue: number,
  worktree: string,
) {
  return [
    ...planMustFix(comment, { proof: "test" }, proofAllowRules(config, issue)),
    ...fileProblems(plan, worktree),
    ...mutationProblems(plan, worktree),
  ];
}

async function park(sc: StepCtx, problems: readonly string[]): Promise<StepResult> {
  const { deps, config, issue, step } = sc;
  const body = [
    "### Planned issue refused",
    "",
    ...problems.map((p) => `- ${p}`),
    "",
    "Fix the issue body, then relabel it `factory:ready`.",
  ].join("\n");
  await postComment(deps, config, issue.number, body, { stage: "import-plan", json: { ok: false, problems } });
  await moveLabel(deps, config, issue.number, step.label, LABEL.needsHuman);
  finish(deps, config, issue.number, "needs-human", `planned issue refused: ${problems.length} problem(s)`);
  return { kind: "stop", outcome: "needs-human" };
}

export const importPlanStep: StepType = {
  async run(sc) {
    const { deps, config, issue, worktree } = sc;
    const parsed = parsePlannedIssue(issue.body ?? "");
    if (!parsed.plan) return park(sc, parsed.problems);
    const imported = planFromIssue(parsed.plan, { body: issue.body ?? "" });
    const problems = importProblems(parsed.plan, imported.comment, config, issue.number, worktree);
    if (problems.length) return park(sc, problems);
    // The risk floor is the same resolver the plan stage uses, so a planned issue cannot rate itself below its files.
    const plan = floorPlanRisk(imported.plan, config);
    const dir = join(worktree, runDir(issue.number));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plan-comment.md"), imported.comment);
    writeFileSync(join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    await postComment(deps, config, issue.number, imported.comment, { stage: "plan", json: plan });
    return { kind: "next", facts: plan };
  },
};
