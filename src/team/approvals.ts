import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfigExplained } from "../config";
import type { OperatorApproval } from "../merge-policy";

// The approver, plus the requester when the team bars them. Undefined when the team policy cannot be
// read: the caller holds the merge rather than guess. A clone with no team directory sets no rule.
export async function operatorApproval(
  github: { getIssue(repo: string, n: number): Promise<{ author?: string }> },
  repo: string,
  issue: number,
  approver: string,
  cloneDir?: string,
): Promise<OperatorApproval | undefined> {
  try {
    const governed = cloneDir !== undefined && existsSync(join(cloneDir, ".factory", "team"));
    const policy = governed
      ? ((await loadConfigExplained(cloneDir)).resolved.values.policy as
          | { approvals?: { requester_cannot_approve?: boolean } }
          | undefined)
      : undefined;
    const requesterCannotApprove = policy?.approvals?.requester_cannot_approve === true;
    const requester = requesterCannotApprove ? (await github.getIssue(repo, issue)).author : undefined;
    return { approver, requester, requesterCannotApprove };
  } catch {
    return undefined;
  }
}
