// The one answer to "what is waiting for me?". Derived from labels and the
// thread (GitHub stays the only state); acting posts the same comment a human
// would type, so the CLI, the dashboard and a later chat channel all go
// through chatops.ts and its trust rule instead of a second command path.

import { parseChatOps, signedBy } from "./chatops";
import { parseDataMarkers } from "./derive";
import { plain } from "./display";
import { epicProgress } from "./engine/epic";
import type { GhComment, GhIssue, GhPr, GitHub } from "./github";
import { LABEL, PARKED_LABELS } from "./labels";
import { riskIndex } from "./risk";
import type { Run } from "./state";

export type InboxKind =
  | "approve-plan"
  | "answer-question"
  | "review-pr"
  | "merge-dry-run"
  | "parked"
  | "failed"
  | "budget"
  | "learning-pr"
  | "stale-pr";
export type InboxAction = "approve" | "revise" | "answer" | "retry" | "cancel";

// Actions that carry the human's own words.
export const ACTIONS_WITH_TEXT: readonly InboxAction[] = ["revise", "answer"];

export interface InboxItem {
  readonly id: string;
  readonly kind: InboxKind;
  readonly issue: number;
  readonly title: string;
  readonly label: string;
  readonly waitingSince: string | undefined;
  readonly ask: string;
  readonly actions: readonly InboxAction[];
  // An epic's checklist, so the list shows how far it is.
  readonly progress?: { done: number; total: number };
}

// Every label that means "a human is needed", and what they can do about it.
// tests/inbox.test.ts walks LABELS so a new waiting state cannot skip this table.
export const WAITING: Readonly<Record<string, { kind: InboxKind; actions: readonly InboxAction[] }>> = {
  [LABEL.awaitingApproval]: { kind: "approve-plan", actions: ["approve", "revise", "cancel"] },
  [LABEL.needsInfo]: { kind: "answer-question", actions: ["answer", "cancel"] },
  [LABEL.inReview]: { kind: "review-pr", actions: ["revise", "cancel"] },
  [LABEL.needsHuman]: { kind: "parked", actions: ["retry", "cancel"] },
  [LABEL.failed]: { kind: "failed", actions: ["retry", "cancel"] },
};

export const WAITING_LABELS: readonly string[] = [LABEL.awaitingApproval, LABEL.inReview, ...PARKED_LABELS];

const ASK_LIMIT = 1200;

function stripMarkers(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").trim();
}

// The runner's latest comment is what the human is being asked about.
function latestRunnerComment(comments: readonly GhComment[]): GhComment | undefined {
  return [...comments]
    .reverse()
    .find((c) => c.body.includes("<!-- factory:") && !c.body.includes("<!-- factory:status"));
}

// `needsHuman` covers every kind of park (a failed setup, a budget cap, a
// step the agent itself stopped on); the label alone can't tell them apart,
// so the marker on the parking comment — the last one posted — does (plan
// v2.7.0 item 7: a budget park gets its own inbox kind, not a generic one).
function isBudgetPark(label: string, issue: GhIssue): boolean {
  if (label !== LABEL.needsHuman) return false;
  const markers = parseDataMarkers(issue.comments);
  return markers.at(-1)?.stage === "budget";
}

// merge-policy.ts's dry-run audit comment carries its own `factory:merge-policy:`
// marker rather than the generic factory:data one, so a dry-run assessment on
// an in-review PR gets its own inbox kind instead of the generic "review-pr"
// (plan v2.8.0 item 2). latestRunnerComment already re-derives from the most
// recent factory: comment, so an older merge-policy comment stops counting
// once a newer non-merge comment is posted.
function isMergeDryRun(label: string, comment: GhComment | undefined): boolean {
  return label === LABEL.inReview && (comment?.body.includes("<!-- factory:merge-policy:") ?? false);
}

// Why the runner parked each issue (runs.reason). The latest factory comment can
// be an older plan, so a parked item leads with this instead.
export function parkReasons(runs: readonly Pick<Run, "issue" | "status" | "reason">[]): Map<number, string> {
  return new Map(
    runs
      .filter((r) => (r.status === "needs-human" || r.status === "failed") && r.reason)
      .map((r) => [r.issue, r.reason!]),
  );
}

const PARKED_KINDS: ReadonlySet<InboxKind> = new Set(["parked", "failed", "budget"]);

// Each item with its task's risk object, rated as the merge rates it, for the inbox badge.
export function inboxWithRisk(issues: readonly GhIssue[], reasons?: ReadonlyMap<number, string>) {
  const risk = riskIndex(issues, { protectedPaths: [] });
  return buildInbox(issues, reasons).map((i) => ({ ...i, risk: risk.get(i.issue) ?? null }));
}

export function buildInbox(issues: readonly GhIssue[], reasons?: ReadonlyMap<number, string>): InboxItem[] {
  const items: InboxItem[] = [];
  for (const issue of issues) {
    const label = issue.labels.map((l) => l.name).find((n) => WAITING[n]);
    if (!label) continue;
    const { kind: labelKind, actions } = WAITING[label]!;
    const comment = latestRunnerComment(issue.comments);
    const kind = isBudgetPark(label, issue) ? "budget" : isMergeDryRun(label, comment) ? "merge-dry-run" : labelKind;
    const reason = PARKED_KINDS.has(kind) ? reasons?.get(issue.number) : undefined;
    const thread = plain(stripMarkers(comment?.body ?? ""));
    const progress = epicProgress(issue.body);
    items.push({
      ...(progress ? { progress } : {}),
      id: `issue-${issue.number}`,
      kind,
      issue: issue.number,
      title: plain(issue.title),
      label,
      waitingSince: comment?.createdAt,
      ask: (reason ? `Parked: ${plain(reason)}\n\n${thread}` : thread).slice(0, ASK_LIMIT),
      actions,
    });
  }
  return items.sort((a, b) => (a.waitingSince ?? "").localeCompare(b.waitingSince ?? "") || a.issue - b.issue);
}

// `factory learn` (plan v2.10.0 item 4) opens a PR with no linked GitHub
// issue, so it can't derive from labels/comments like buildInbox. Visibility
// only: no chatops actions exist for a learning PR, it never auto-merges.
export function learningPrItems(prs: readonly GhPr[]): InboxItem[] {
  return prs
    .filter((pr) => pr.headRefName.startsWith("factory/learning-"))
    .map((pr) => ({
      id: `learning-pr-${pr.number}`,
      kind: "learning-pr" as const,
      issue: pr.number,
      title: `Learning PR #${pr.number}`,
      label: "",
      waitingSince: undefined,
      ask: `Batched memory/skill-edit proposals: ${pr.url}`,
      actions: [] as const,
    }))
    .sort((a, b) => a.issue - b.issue);
}

export function commandText(action: InboxAction, text: string): string {
  if (action === "answer") return text;
  return action === "revise" ? `/factory revise ${text}` : `/factory ${action}`;
}

export class InboxError extends Error {}

export async function act(
  github: Pick<GitHub, "commentIssue">,
  repo: string,
  item: Pick<InboxItem, "issue" | "actions" | "kind">,
  action: InboxAction,
  text = "",
  // Who sent it, when the runner's account posts on their behalf (the control plane).
  by?: string,
): Promise<string> {
  if (!item.actions.includes(action)) throw new InboxError(`${action} is not available for a ${item.kind} item`);
  const words = text.trim();
  if (ACTIONS_WITH_TEXT.includes(action) && !words) throw new InboxError(`${action} needs text`);
  const body = by ? signedBy(commandText(action, words), by) : commandText(action, words);
  // Round-trip through the parser so a UI command fails exactly like a typed one would.
  if (action !== "answer" && parseChatOps(body).type !== action)
    throw new InboxError(`not a recognized /factory command: ${body}`);
  await github.commentIssue(repo, item.issue, body);
  return body;
}

// What a chat or push channel implements (v3.1): show the waiting items, and
// send replies back through `act`, so it shares the trust rule with everything else.
export interface InboxChannel {
  readonly name: string;
  send(items: readonly InboxItem[]): Promise<void>;
}

// `factory inbox [issue [action]] [--flag value] [--json]`: the positional words after the verb.
export function inboxPositionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--json") continue;
    if (argv[i]!.startsWith("--"))
      i++; // a flag and its value
    else out.push(argv[i]!);
  }
  return out;
}
