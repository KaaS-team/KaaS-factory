// R1b: a plan step that runs again on an issue whose body has not changed reuses the plan already
// on the thread, so a retry or a wiped workspace neither pays for nor posts a different plan.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir, stepStop, type PlanArtifact } from "../artifacts";
import { isHumanComment, isTrusted, parseChatOps } from "../chatops";
import { parseDataMarkers } from "../derive";
import type { GhIssue } from "../github";
import type { CheckedPlan } from "./plan-critic";
import { sha256 } from "./import-plan";

export type HashedPlan = PlanArtifact & { readonly bodyHash?: string };

// The newest trusted plan on the thread, when the body is the one it was planned from and no human has asked for a new plan since.
export function reusablePlan(issue: GhIssue): { json: HashedPlan; comment: string } | undefined {
  const comments = issue.comments;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const plan = comments[i]!;
    if (!isTrusted(plan)) continue;
    const marker = parseDataMarkers([plan]).find((m) => m.stage === "plan");
    if (!marker) continue;
    const json = marker.json as HashedPlan | undefined;
    if (!json || stepStop(json) || json.status === "needs-info") return undefined;
    if (comments.slice(i + 1).some((c) => isHumanComment(c) && parseChatOps(c.body).type !== "approve"))
      return undefined;
    if (json.bodyHash !== sha256(issue.body)) return undefined;
    return { json, comment: plan.body.replace(/\n*<!-- factory:data \{.*?\} -->\s*$/s, "").trimEnd() };
  }
  return undefined;
}

// Every plan the runner posts carries the hash of the body it was planned from.
export function stampBodyHash<T extends { json?: PlanArtifact }>(parsed: T, issue: GhIssue): T {
  if (!parsed.json) return parsed;
  return { ...parsed, json: { ...parsed.json, bodyHash: sha256(issue.body) } as HashedPlan };
}

export function reusedPlan(
  worktree: string,
  issueNumber: number,
  prior: { json: HashedPlan; comment: string },
): CheckedPlan {
  const dir = join(worktree, runDir(issueNumber));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(prior.json, null, 2));
  writeFileSync(join(dir, "plan-comment.md"), prior.comment);
  const result: CheckedPlan["result"] = {
    exitCode: 0,
    events: [],
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    costReported: true,
    permissionDenials: [],
  } as unknown as CheckedPlan["result"];
  return {
    result,
    comment: `${prior.comment}\n\n_Plan reused: the issue body is unchanged since this plan was written._`,
    parsed: { json: prior.json },
  };
}
