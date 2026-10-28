// What the factory needs from a tracker (issues, comments, labels) and a code
// host (PRs). GitHub (and GHE through GH_HOST) implements both in src/github.ts;
// makeScm (src/scm.ts) pairs a tracker with a code host.

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  comments: GhComment[];
  // Only populated by getIssue (blockers.ts is the one caller that needs
  // them); listIssuesByLabel and listOpenIssues leave both undefined.
  state?: "OPEN" | "CLOSED";
  stateReason?: string | null;
}

export interface GhComment {
  id: number;
  // `gh` gives a node id in `id`; the REST id an edit needs is the
  // #issuecomment-N in the url. Fakes set a numeric `id` and no url.
  url?: string;
  author: string;
  authorAssociation: string;
  body: string;
  createdAt: string;
}

export interface CreatePrOptions {
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface GhPr {
  number: number;
  url: string;
  state: string;
  headRefName: string;
  isDraft: boolean;
  closingIssuesReferences?: { number: number }[];
  isCrossRepository?: boolean;
  // ISO time of the last push, comment or review; the stale-PR nudge reads it (src/stale-pr.ts).
  updatedAt?: string;
}

export interface CiCheck {
  readonly name?: string;
  readonly context?: string;
  readonly status?: string;
  readonly state?: string;
  readonly conclusion?: string;
}

export interface PrStatus {
  readonly state: "open" | "closed" | "merged";
  readonly headRefOid: string;
  readonly closingIssuesReferences: readonly { number: number }[];
  readonly statusCheckRollup: readonly CiCheck[];
}

// merge-policy.ts's readiness snapshot (src/merge-policy.ts). mergeable and
// reviewDecision come straight off `gh pr view`; hasUnresolvedReviewThreads
// needs a separate GraphQL call, since neither `gh pr view` nor `gh pr
// checks` exposes thread resolution.
export interface MergeReadiness {
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly baseRefName: string;
  readonly headRefOid: string;
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  readonly reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  readonly hasUnresolvedReviewThreads: boolean;
  // Every CHANGES_REQUESTED review is against a commit the head has since
  // moved past (v2.9.0 item 3, from assembler's unmerged fix branch, idea
  // only, no code copied): a reviewer who asked for changes on an old commit
  // no longer blocks a PR that has since been updated.
  readonly changesRequestedStale: boolean;
  // Logins whose latest review approves; absent when the host did not say.
  readonly approvedBy?: readonly string[];
}

// A user's role on the repo, highest first. "none" when they are not a collaborator.
export interface RateBudget {
  readonly remaining: number;
  readonly limit: number;
}

// The tracker refused a call for rate limiting and said when it lifts (epoch seconds).
export class RateLimitError extends Error {
  constructor(
    readonly status: number,
    readonly resetAt: number,
  ) {
    super(`rate limited (HTTP ${status}), resets at ${new Date(resetAt * 1000).toISOString()}`);
  }
}

export type RepoRole = "admin" | "maintain" | "write" | "triage" | "read" | "none";
export const TRUSTED_ROLES: readonly RepoRole[] = ["admin", "maintain", "write"];

// One file a PR changes; merge-policy.ts's ChangedFile has the same shape.
export interface PrFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

// The issue side: where work is filed, discussed and labelled. GitHub is one
// tracker; src/adapters/http-tracker.ts speaks Tracker API v1
// (docs/tracker-api.md) to any other, such as kaas Tasks or a Linear bridge.
export interface TrackerPort {
  listIssuesByLabel(repo: string, label: string): Promise<GhIssue[]>;
  getIssue(repo: string, number: number): Promise<GhIssue>;
  // Optional: every label's open issues in one request. The watcher falls back to one listIssuesByLabel per label.
  listIssuesByLabels?(repo: string, labels: readonly string[]): Promise<Map<string, GhIssue[]>>;
  listOpenIssues(repo: string): Promise<GhIssue[]>;
  commentIssue(repo: string, number: number, body: string): Promise<number | undefined>;
  editComment(repo: string, commentId: number, body: string): Promise<void>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  removeLabels(repo: string, number: number, labels: string[]): Promise<void>;
  setStateLabel(repo: string, number: number, current: string[], next: string): Promise<void>;
  closeIssue(repo: string, number: number): Promise<void>;
  // Optional: a tracker that cannot edit a body leaves an epic's checklist as filed.
  editIssueBody?(repo: string, number: number, body: string): Promise<void>;
  reopenIssue(repo: string, number: number): Promise<void>;
  createIssue(repo: string, title: string, body: string, labels: string[]): Promise<number>;
  listLabels(repo: string): Promise<string[]>;
  ensureLabel(repo: string, name: string, color: string, description: string): Promise<void>;
  currentLogin(): Promise<string>;
  // Who last applied `label` to the issue; undefined if the history has no such event.
  labeledBy(repo: string, number: number, label: string): Promise<string | undefined>;
  roleOf(repo: string, login: string): Promise<RepoRole>;
  authStatus(): Promise<{ ok: boolean; detail: string }>;
}

// The code side: branches become pull requests, checked and merged. Always
// GitHub today, whichever tracker holds the issues.
export interface CodeHostPort {
  createPr(opts: CreatePrOptions): Promise<string>;
  listPrs(repo: string, opts?: { state?: string }): Promise<GhPr[]>;
  getPr(repo: string, number: number): Promise<GhPr>;
  findPrByHead(repo: string, head: string): Promise<GhPr | undefined>;
  // The newest merged PR on this head, whoever merged it. One closed without merging is not one.
  mergedPrByHead(repo: string, head: string): Promise<GhPr | undefined>;
  prFeedback(repo: string, head: string): Promise<GhComment[]>;
  markReady(repo: string, ref: string | number, ready: boolean): Promise<void>;
  closePr(repo: string, number: number): Promise<void>;
  prStatus(repo: string, number: number): Promise<PrStatus>;
  mergeReadiness(repo: string, number: number): Promise<MergeReadiness>;
  prDiff(repo: string, prNumber: number): Promise<string>;
  // The open PR for this issue: by "Closes #n" when the tracker is GitHub, by head branch otherwise.
  prForIssue(repo: string, issueNumber: number, opts?: { excludeHead?: string }): Promise<GhPr | undefined>;
  mergePr(repo: string, number: number, headSha: string): Promise<void>;
  // Optional: the files a PR changes, and a file's text at a ref (undefined when absent).
  prFiles?(repo: string, prNumber: number): Promise<PrFile[]>;
  fileAtRef?(repo: string, path: string, ref: string): Promise<string | undefined>;
  // Optional: a fake has no budget to read, and the plane then keeps its pace.
  rateLimit?(repo: string): Promise<RateBudget>;
  authStatus(): Promise<{ ok: boolean; detail: string }>;
}

// Everything the runner needs; src/scm.ts composes one from config.
export type ScmPort = TrackerPort & CodeHostPort;
