import type { CiResult } from "../src/ci";
import type { FactoryConfig } from "../src/config";
import type { MergeReadiness } from "../src/github";
import { attemptMerge, decideOperatorMerge, type MergeDecision, renderOperatorAuditComment } from "../src/merge-policy";
import type { ScmPort } from "../src/ports/scm";
import { codeownersFromBase, rulesFor } from "../src/profile-rules";
import { operatorApproval } from "../src/team/approvals";

export interface OperatorMerge {
  merged: boolean;
  decision?: MergeDecision;
  error?: string;
  // 403 when the team barred the requester, so the plane's audit log records a refusal.
  status: number;
}

// The dashboard's "Approve and merge": decide, attempt, and post the audit comment to the issue thread.
// Anything it cannot read holds the merge (502) rather than guess.
export async function operatorMerge(
  github: ScmPort,
  repo: string,
  pr: number,
  issue: number,
  facts: {
    readiness: MergeReadiness;
    ci: CiResult;
    approver: string;
    profile?: FactoryConfig["profile"];
    cloneDir?: string;
  },
): Promise<OperatorMerge> {
  const { readiness } = facts;
  let owners: Parameters<typeof decideOperatorMerge>[2];
  if (rulesFor(facts.profile).codeownerApproval) {
    const files = await github.prFiles?.(repo, pr).catch(() => undefined);
    try {
      const rules = await codeownersFromBase(github, repo, readiness.baseRefName);
      owners = { rules, files, approvedBy: readiness.approvedBy ?? [] };
    } catch {
      return { merged: false, status: 502, error: "CODEOWNERS could not be read, so the merge is held" };
    }
  }
  const approval = await operatorApproval(github, repo, issue, facts.approver, facts.cloneDir);
  if (!approval)
    return { merged: false, status: 502, error: "the team policy could not be read, so the merge is held" };
  const decision = decideOperatorMerge(readiness, facts.ci, owners, approval);
  const merged = await attemptMerge(github, repo, pr, decision);
  await github.commentIssue(repo, issue, renderOperatorAuditComment(decision));
  const barred =
    decision.outcome === "refuse" && decision.refusals.some((x) => x.reason === "requester_cannot_approve");
  return { merged, decision, status: barred ? 403 : 200 };
}
