// One rubric pass over a plan that already passed the model-free checks (#156): intent, scope, a
// verify step per task, a risk and an estimate. A revise goes back through the plan critic's single
// revision; its reasons are kept as a pending lesson. The pass is opt-in: only a skill the repo commits runs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir, stepStop } from "../artifacts";
import type { FactoryConfig } from "../config";
import type { GhIssue } from "../github";
import { resolveSkill } from "../harness-defaults";
import { runStage, type WatchDeps } from "./common";
import type { CheckedPlan } from "./plan-critic";

export const RUBRIC_SKILL = "factory-plan-rubric";

export interface RubricVerdict {
  verdict: "pass" | "revise";
  reasons: string[];
}

export function parseRubric(raw: unknown): RubricVerdict | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { verdict, reasons } = raw as Record<string, unknown>;
  if (verdict !== "pass" && verdict !== "revise") return undefined;
  if (!Array.isArray(reasons) || !reasons.every((r) => typeof r === "string")) return undefined;
  return { verdict, reasons: reasons as string[] };
}

export function rubricPrompt(skill: string, issueNumber: number, comment: string, plan: object): string {
  return [
    skill.replace(/^---\n[\s\S]*?\n---\n/, "").trim(),
    "## Plan comment",
    comment,
    "## plan.json",
    `\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``,
    `Write only \`${runDir(issueNumber)}/plan-rubric.json\` as {"verdict": "pass" | "revise", "reasons": [...]}.`,
  ].join("\n\n");
}

export async function planRubric(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  worktree: string,
  run: CheckedPlan & { mustFix: string[] },
  opts: Parameters<typeof runStage>[5],
): Promise<string[]> {
  const plan = run.parsed.json;
  if (run.result.exitCode !== 0 || !plan || stepStop(plan) || plan.status === "needs-info") return [];
  if (!run.comment || run.mustFix.length) return [];
  if (resolveSkill(worktree, RUBRIC_SKILL)?.source !== "repo") return [];
  const skillPath = resolveSkill(worktree, RUBRIC_SKILL)!.path;
  const prompt = rubricPrompt(readFileSync(skillPath, "utf8"), issue.number, run.comment, plan);
  const result = await runStage(deps, config, issue, "plan", worktree, { ...opts, prompt });
  // runStage cleared the plan's own files; put the plan back whatever the rubric did.
  const dir = join(worktree, runDir(issue.number));
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2));
  writeFileSync(join(dir, "plan-comment.md"), run.comment);
  const file = join(dir, "plan-rubric.json");
  if (result.exitCode !== 0 || !existsSync(file)) return [];
  let verdict: RubricVerdict | undefined;
  try {
    verdict = parseRubric(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
  if (verdict?.verdict !== "revise" || !verdict.reasons.length) return [];
  const lesson = `Plan rubric for #${issue.number}:\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}`;
  deps.state.completeRetro(deps.state.queueRetro(config.repo, issue.number, "plan-rubric"), { lesson });
  return verdict.reasons.map((r) => `Plan rubric: ${r}`);
}
