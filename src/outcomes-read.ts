// Reads outcomes from the repo itself: pull requests, issues and the factory's own comments.
// A work item is an issue that has a factory label or a recorded workflow; its cost comes from
// the stage ledger and is put on one outcome, so a PR and its issue are never counted twice.

import { isHumanComment, isTrusted } from "./chatops";
import { parseDataMarkers } from "./derive";
import { WORKFLOW_MARKER } from "./engine/late-route";
import type { CommandRunner, GhComment } from "./github";
import type { Outcome } from "./outcomes";

interface RawComment {
  author?: { login?: string };
  authorAssociation: string;
  body: string;
  createdAt: string;
}
interface RawIssue {
  number: number;
  state: string;
  stateReason?: string | null;
  closedAt?: string | null;
  labels: { name: string }[];
  comments: RawComment[];
}
interface RawPr {
  number: number;
  state: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  closingIssuesReferences?: { number: number }[];
}

export interface OutcomeLedger {
  // The cost of an issue's stage runs; null when any is unknown, undefined when it has none.
  costOf(issue: number): number | null | undefined;
}

const asComment = (c: RawComment): GhComment => ({
  id: 0,
  author: c.author?.login ?? "",
  authorAssociation: c.authorAssociation,
  body: c.body,
  createdAt: c.createdAt,
});

// The workflow a trusted comment recorded at pickup, else the repo's own.
export function workflowOfIssue(comments: readonly GhComment[], fallback: string): string {
  const marker = parseDataMarkers(comments.filter(isTrusted)).find((m) => m.stage === WORKFLOW_MARKER);
  return (marker?.json as { name?: string } | undefined)?.name ?? fallback;
}

const TEAM_LABEL = "team:";

async function list<T>(runner: CommandRunner, args: string[]): Promise<T[]> {
  const r = await runner.run(args);
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout || "[]") as T[];
}

export async function readOutcomes(
  runner: CommandRunner,
  repo: string,
  opts: { defaultWorkflow: string; ledger: OutcomeLedger },
): Promise<Outcome[]> {
  const [issues, prs] = await Promise.all([
    list<RawIssue>(runner, [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,state,stateReason,closedAt,labels,comments",
    ]),
    list<RawPr>(runner, [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,state,mergedAt,closedAt,closingIssuesReferences",
    ]),
  ]);
  const out: Outcome[] = [];
  for (const issue of issues) {
    const comments = issue.comments.map(asComment);
    const workflow = workflowOfIssue(comments, "");
    const factory = issue.labels.some((l) => l.name.startsWith("factory:")) || workflow !== "";
    if (!factory) continue;
    const base = {
      workflow: workflow || opts.defaultWorkflow,
      team: issue.labels.find((l) => l.name.startsWith(TEAM_LABEL))?.name.slice(TEAM_LABEL.length) ?? "(none)",
    };
    const mine: Outcome[] = [];
    const pr = prs.find((p) => p.closingIssuesReferences?.some((r) => r.number === issue.number));
    if (pr && (pr.mergedAt || (pr.state === "CLOSED" && pr.closedAt)))
      mine.push({
        ...base,
        kind: "pr",
        at: (pr.mergedAt ?? pr.closedAt)!,
        state: pr.mergedAt ? "merged" : "closed",
        cost_usd: 0,
      });
    else if (!pr && issue.state === "CLOSED" && issue.closedAt)
      mine.push({
        ...base,
        kind: "issue",
        at: issue.closedAt,
        state: issue.stateReason === "NOT_PLANNED" ? "dismissed" : "kept",
        cost_usd: 0,
      });
    // A question left on an open thread may still be answered, so only a closed thread settles it.
    if (issue.state === "CLOSED" && issue.closedAt) {
      comments.forEach((c, i) => {
        const asks =
          c.body.includes("<!-- factory:") && !parseDataMarkers([c]).some((m) => m.stage === WORKFLOW_MARKER);
        if (!asks) return;
        const answered = comments.slice(i + 1).some(isHumanComment);
        mine.push({
          ...base,
          kind: "comment",
          at: issue.closedAt!,
          state: answered ? "acted" : "ignored",
          cost_usd: 0,
        });
      });
    }
    const cost = opts.ledger.costOf(issue.number);
    if (mine.length && cost !== undefined) mine[0]!.cost_usd = cost;
    out.push(...mine);
  }
  return out;
}
