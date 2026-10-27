// Shared in-memory fakes for the state-machine tests: GitHub, git, gates and
// a scripted per-stage executor. No `gh`, `git`, model or network. GitHub and
// Git hold a private CommandRunner field, so a plain object can't satisfy the
// type; subclassing and overriding every public method is the honest fake.

import { mayTake, type LeaseRecord } from "../src/core/lease";
import type { LeasePort } from "../src/ports/lease";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { ReplayExecutor, type StageName, type StageRunOptions, type StageRunResult } from "../src/executor";
import { runDir } from "../src/artifacts";
import {
  GitHub,
  type CreatePrOptions,
  type GhComment,
  type GhIssue,
  type GhPr,
  type MergeReadiness,
  type PrStatus,
  type RepoRole,
} from "../src/github";
import { Git } from "../src/git";
import type { ChangedFile } from "../src/merge-policy";
import type { GateRunner } from "../src/gates";
import type { HoldoutConfig } from "../src/config";
import type { HoldoutRunner } from "../src/holdout";

// Strictly increasing timestamps, so "newer than" comparisons never tie the
// way `new Date()` can inside one millisecond.
let clock = Date.parse("2026-01-01T00:00:00Z");
export function nextIso(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

// What a customer reading the tracker must never see: this machine's name, a
// `.local` host, a dollar amount or a model. Only the text outside HTML
// comments is visible; the factory's hidden data markers may carry anything.
const HOST = hostname().toLowerCase();
// Built from a string: semgrep's TypeScript parser cannot read this pattern as a regex literal.
const HIDDEN_MARKERS = new RegExp("<!--[\\s\\S]*?-->", "g");
export function visibleLeaks(body: string): string[] {
  const visible = body.replace(HIDDEN_MARKERS, "").toLowerCase();
  const out: string[] = [];
  if (HOST && visible.includes(HOST)) out.push(`hostname ${HOST}`);
  if (/[\w-]\.local\b/.test(visible)) out.push(".local host");
  if (/\$\s?\d/.test(visible)) out.push("dollar amount");
  if (/\bmodel\b/.test(visible)) out.push("model");
  return out;
}

// The checking fakes (FakeGitHub, MemoryTracker) call this on every write, so
// every test that drives a comment through them checks it.
export function assertCustomerSafe(body: string): void {
  const leaks = visibleLeaks(body);
  if (leaks.length) throw new Error(`a tracker comment shows operator detail (${leaks.join(", ")}): ${body}`);
}

// ---------- fakes: in-memory GitHub and Git, no `gh`/`git` process ----------

export class FakeGitHub extends GitHub {
  issues = new Map<number, GhIssue>();
  prs: GhPr[] = [];
  createdPrs: CreatePrOptions[] = [];
  private nextCommentId = 1000;
  private nextPrNumber = 1;

  constructor(issues: GhIssue[]) {
    super();
    for (const i of issues) this.issues.set(i.number, i);
  }

  override async listIssuesByLabel(_repo: string, label: string): Promise<GhIssue[]> {
    return [...this.issues.values()].filter((i) => i.labels.some((l) => l.name === label));
  }

  override async getIssue(_repo: string, number: number): Promise<GhIssue> {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no such issue ${number}`);
    return issue;
  }

  override async listOpenIssues(_repo: string): Promise<GhIssue[]> {
    return [...this.issues.values()].filter((i) => i.state !== "CLOSED");
  }

  // Who applied a label, and each login's role; by default a maintainer applied everything.
  labelers = new Map<number, string | undefined>();
  // "human" writes every scripted comment; "maintainer" applies every label.
  roles = new Map<string, RepoRole>([
    ["maintainer", "admin"],
    ["human", "admin"],
  ]);
  override async labeledBy(_repo: string, number: number): Promise<string | undefined> {
    return this.labelers.has(number) ? this.labelers.get(number) : "maintainer";
  }
  override async roleOf(_repo: string, login: string): Promise<RepoRole> {
    return this.roles.get(login) ?? "none";
  }

  // When set, the repo's labels as gh sees them: createIssue rejects one that is missing, as gh
  // does, and ensureLabel adds it. Unset, every label exists.
  repoLabels?: Set<string>;

  override async createIssue(_repo: string, title: string, body: string, labels: string[]): Promise<number> {
    const missing = this.repoLabels && labels.find((l) => !this.repoLabels!.has(l));
    if (missing) throw new Error(`could not add label: '${missing}' not found`);
    assertCustomerSafe(`${title}\n${body}`);
    const number = Math.max(0, ...this.issues.keys()) + 1;
    this.issues.set(number, { number, title, body, labels: labels.map((name) => ({ name })), comments: [] });
    return number;
  }

  override async commentIssue(_repo: string, number: number, body: string): Promise<number> {
    assertCustomerSafe(body);
    const issue = this.issues.get(number)!;
    const id = this.nextCommentId++;
    const comment: GhComment = { id, author: "factory-bot", authorAssociation: "OWNER", body, createdAt: nextIso() };
    issue.comments = [...issue.comments, comment];
    return id;
  }

  editCount = 0;
  // Comments and reviews a human left on the draft PR.
  prComments: GhComment[] = [];

  override async findPrByHead(_repo: string, head: string): Promise<GhPr | undefined> {
    return this.prs.find((p) => p.state === "open" && p.headRefName === head);
  }

  override async mergedPrByHead(_repo: string, head: string): Promise<GhPr | undefined> {
    return this.prs.findLast((p) => p.state === "merged" && p.headRefName === head);
  }

  override async getPr(_repo: string, number: number): Promise<GhPr> {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`no such PR #${number}`);
    return pr;
  }

  override async prFeedback(): Promise<GhComment[]> {
    return this.prComments;
  }

  // A human comment on the issue, from any association (default: the owner).
  say(issue: number, body: string, authorAssociation = "OWNER", author = "human"): void {
    const i = this.issues.get(issue)!;
    i.comments = [...i.comments, { id: this.nextCommentId++, author, authorAssociation, body, createdAt: nextIso() }];
  }

  sayOnPr(body: string, authorAssociation = "OWNER"): void {
    this.prComments = [...this.prComments, { id: 0, author: "human", authorAssociation, body, createdAt: nextIso() }];
  }

  override async editComment(_repo: string, commentId: number, body: string): Promise<void> {
    assertCustomerSafe(body);
    this.editCount += 1;
    for (const issue of this.issues.values()) {
      const comment = issue.comments.find((c) => c.id === commentId);
      if (comment) (comment as { body: string }).body = body;
    }
  }

  // Every label this fake ever applied, so a test can prove which states were reached.
  seenLabels = new Set<string>();

  override async addLabels(_repo: string, number: number, labels: string[]): Promise<void> {
    for (const l of labels) this.seenLabels.add(l);
    const issue = this.issues.get(number)!;
    const names = new Set(issue.labels.map((l) => l.name));
    for (const l of labels) names.add(l);
    issue.labels = [...names].map((name) => ({ name }));
  }

  override async removeLabels(_repo: string, number: number, labels: string[]): Promise<void> {
    const issue = this.issues.get(number)!;
    const remove = new Set(labels);
    issue.labels = issue.labels.filter((l) => !remove.has(l.name));
  }

  override async createPr(opts: CreatePrOptions): Promise<string> {
    this.createdPrs.push(opts);
    const number = this.nextPrNumber++;
    const url = `https://github.com/${opts.repo}/pull/${number}`;
    this.prs.push({ number, url, state: "open", headRefName: opts.head, isDraft: Boolean(opts.draft) });
    return url;
  }

  // Ready-for-review flips, in order: [head, ready].
  readyCalls: [string, boolean][] = [];

  override async markReady(_repo: string, ref: string | number, ready: boolean): Promise<void> {
    this.readyCalls.push([String(ref), ready]);
    const pr = this.prs.find((p) => p.headRefName === ref || p.number === ref);
    if (pr) (pr as { isDraft: boolean }).isDraft = !ready;
  }

  override async listPrs(): Promise<GhPr[]> {
    return this.prs.filter((p) => p.state === "open");
  }

  override async closePr(_repo: string, number: number): Promise<void> {
    const pr = this.prs.find((p) => p.number === number);
    if (pr) (pr as { state: string }).state = "closed";
  }

  closed: number[] = [];

  override async closeIssue(_repo: string, number: number): Promise<void> {
    this.closed.push(number);
  }

  override async listLabels(): Promise<string[]> {
    return [];
  }

  override async ensureLabel(_repo: string, name: string): Promise<void> {
    this.repoLabels?.add(name);
  }
  override async currentLogin(): Promise<string> {
    return "factory-bot";
  }

  // Queued CI/merge-readiness snapshots per PR number: each prStatus call
  // shifts the next one, then repeats the last (the "trees" pattern in
  // FakeGit below), so a test can move a PR from pending to green across
  // successive polls without a real `gh` or a real clock.
  private ciStatuses = new Map<number, PrStatus[]>();

  queuePrStatus(prNumber: number, status: PrStatus): void {
    const arr = this.ciStatuses.get(prNumber) ?? [];
    arr.push(status);
    this.ciStatuses.set(prNumber, arr);
  }

  override async prStatus(_repo: string, number: number): Promise<PrStatus> {
    const arr = this.ciStatuses.get(number);
    if (!arr || arr.length === 0) throw new Error(`no ci status queued for pr ${number}`);
    return arr.length > 1 ? arr.shift()! : arr[0]!;
  }

  // Merge calls this fake ever made, so a test can prove merge-policy never
  // calls it (policy: "off") or calls it exactly once, with what it passed.
  merged: { repo: string; prNumber: number; headSha: string }[] = [];

  override async mergePr(repo: string, prNumber: number, headSha: string): Promise<void> {
    this.merged.push({ repo, prNumber, headSha });
    const pr = this.prs.find((p) => p.number === prNumber);
    if (pr) (pr as { state: string }).state = "merged";
  }

  // Queued merge-readiness snapshots per PR number, same shift-then-repeat
  // pattern as ciStatuses/trees above.
  private mergeReadinessQueue = new Map<number, MergeReadiness[]>();

  queueMergeReadiness(prNumber: number, readiness: MergeReadiness): void {
    const arr = this.mergeReadinessQueue.get(prNumber) ?? [];
    arr.push(readiness);
    this.mergeReadinessQueue.set(prNumber, arr);
  }

  override async mergeReadiness(_repo: string, number: number): Promise<MergeReadiness> {
    const arr = this.mergeReadinessQueue.get(number);
    if (!arr || arr.length === 0) throw new Error(`no merge readiness queued for pr ${number}`);
    return arr.length > 1 ? arr.shift()! : arr[0]!;
  }
}

export class FakeGit extends Git {
  claimResult = true;
  claims = 0;
  pushed: number[] = [];
  committed: string[] = [];

  override async claim(): Promise<boolean> {
    this.claims++;
    return this.claimResult;
  }

  // Files every new worktree starts with, as if checked out from the repo.
  seed: Record<string, string> = {};

  override async ensureWorktree(_cloneDir: string, worktreeDir: string, issue: number): Promise<void> {
    mkdirSync(join(worktreeDir, runDir(issue)), { recursive: true });
    for (const [name, content] of Object.entries(this.seed)) {
      mkdirSync(dirname(join(worktreeDir, name)), { recursive: true });
      writeFileSync(join(worktreeDir, name), content);
    }
  }

  override async removeWorktree(_cloneDir: string, worktreeDir: string): Promise<void> {
    rmSync(worktreeDir, { recursive: true, force: true });
  }

  // The runner commits (audit finding #4) and diffs against base before
  // pushing (finding #12); this fake just records that it happened, since
  // there's no real git repo backing the temp worktree in these tests.
  override async commitAll(_worktreeDir: string, message: string): Promise<boolean> {
    this.committed.push(message);
    return true;
  }

  changed: string[] = [];

  override async changedFiles(): Promise<string[]> {
    return this.changed;
  }

  // Defaults to one line added per changed file; a test that cares about
  // exact counts sets this directly instead.
  diffStatOverride: ChangedFile[] | undefined;

  override async diffStat(): Promise<ChangedFile[]> {
    return this.diffStatOverride ?? this.changed.map((path) => ({ path, additions: 1, deletions: 0 }));
  }

  pushCode = 0;
  pushStderr = "";
  override async push(_worktreeDir: string, issue: number) {
    this.pushed.push(issue);
    return { stdout: "", stderr: this.pushStderr, code: this.pushCode };
  }

  pushedBranches: string[] = [];
  override async pushBranch(_worktreeDir: string, branch: string) {
    this.pushedBranches.push(branch);
    return { stdout: "", stderr: "", code: 0 };
  }

  branchWorktrees: string[] = [];
  override async ensureBranchWorktree(_cloneDir: string, worktreeDir: string, branch: string): Promise<void> {
    this.branchWorktrees.push(branch);
    mkdirSync(worktreeDir, { recursive: true });
  }

  trees = ["faketree"];
  // Each call returns the next tree, then repeats the last, so a test can move HEAD between build and verify.
  override async treeHash(): Promise<string> {
    return this.trees.length > 1 ? this.trees.shift()! : this.trees[0]!;
  }

  diffText = "diff --git a/x b/x";
  override async diff(): Promise<string> {
    return this.diffText;
  }

  head = "abc";
  remoteHead: string | undefined = "abc";
  commits = true;

  override async headSha(): Promise<string> {
    return this.head;
  }

  remoteHeadError: string | undefined;

  override async remoteHeadSha(): Promise<string | undefined> {
    if (this.remoteHeadError) throw new Error(this.remoteHeadError);
    return this.remoteHead;
  }

  override async hasCommits(): Promise<boolean> {
    return this.commits;
  }

  // Real git would shell out to `git sparse-checkout`; there's no real repo
  // backing these fakes' worktrees, so this just records what was asked for.
  sparseExcluded: string[] | undefined;
  override async excludeFromSparseCheckout(_worktreeDir: string, holdoutPaths: readonly string[]): Promise<void> {
    this.sparseExcluded = [...holdoutPaths];
  }
}

// The runner grades the build itself now (audit finding #11), so every test
// that reaches the build stage needs a gate result. Defaults to green; a
// test can swap `line` for a red one to exercise the failure path.
export class FakeGateRunner implements GateRunner {
  line = "FACTORY_GATES: status=GREEN passed=10 failed=0 skipped=0 failed_gates=-";
  runs = 0;
  // Lines to return before falling back to `line`, one per run.
  next: string[] = [];
  async run(_worktreeDir: string) {
    this.runs++;
    return { stdout: this.next.shift() ?? this.line, stderr: "", code: 0 };
  }
}

// Defaults to passing, so every existing scenario that never configures
// holdout is unaffected; a test that cares sets `ok`/`detail` directly.
export class FakeHoldoutRunner implements HoldoutRunner {
  ok = true;
  detail = "";
  runs = 0;
  // Results to return before falling back to `ok`/`detail`, one per run —
  // same shape as FakeGateRunner's `next`, for scripting fail-then-pass retries.
  next: boolean[] = [];
  async run(_worktreeDir: string, _base: string, _holdout: HoldoutConfig) {
    this.runs++;
    const result = this.next.length > 0 ? this.next.shift()! : this.ok;
    return { stdout: result ? "" : this.detail, stderr: "", code: result ? 0 : 1 };
  }
}

export function baseIssue(number: number, labels: string[]): GhIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: "do the thing",
    labels: labels.map((name) => ({ name })),
    comments: [],
  };
}

export function fixtureFor(stage: StageName, issue: number) {
  return ReplayExecutor.fromLines(stage, issue, [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write" }] } }),
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.01 }),
  ]);
}

// watch.ts now clears a stage's artifact files before running it (audit
// finding #9), so a test can no longer pre-seed them on disk before calling
// processReadyIssue/resumeNeedsInfo — they'd be deleted before the fake
// executor ever runs. Instead each `push` carries the files that round's
// "claude" run would have written, and runStage() writes them itself, right
// where the clear just happened. A queue per stage:issue key lets a resumed
// stage (needs-info, reject-and-rebuild) return different output each round.
export class MultiStageExecutor {
  private readonly queue = new Map<
    string,
    Array<{ executor: ReplayExecutor; files?: Record<string, string>; result?: Partial<StageRunResult> }>
  >();

  // `result` overrides fields of the replayed result (a kill, a denial, a non-zero exit).
  push(
    stage: StageName,
    issue: number,
    executor: ReplayExecutor,
    files?: Record<string, string>,
    result?: Partial<StageRunResult>,
  ): void {
    const key = `${stage}:${issue}`;
    const arr = this.queue.get(key) ?? [];
    arr.push({ executor, files, result });
    this.queue.set(key, arr);
  }

  // What each run was asked to resume, in order: a rebuild's session and failure tail.
  readonly resumed: Array<StageRunOptions["resume"]> = [];
  // The MCP servers each run was handed, by stage.
  readonly mcp: Array<[StageName, StageRunOptions["mcp"]]> = [];
  // The issue scope each run was handed, by stage: what picks the agent's model tier.
  readonly scopes: Array<[StageName, StageRunOptions["scope"]]> = [];
  // The model the runner picked for each run, by stage.
  readonly models: Array<[StageName, string | undefined]> = [];
  // The verify rejects each run was told of, by stage: what climbs the build a tier.
  readonly rejects: Array<[StageName, StageRunOptions["rejects"]]> = [];
  // The agent and timeout a workflow step pinned, by stage.
  readonly pinned: Array<[StageName, string | undefined, number | undefined]> = [];

  async runStage(opts: {
    stage: StageName;
    issue: number;
    cwd: string;
    maxBudgetUsd: number;
    resume?: StageRunOptions["resume"];
    mcp?: StageRunOptions["mcp"];
    scope?: StageRunOptions["scope"];
    rejects?: StageRunOptions["rejects"];
    agent?: string;
    model?: string;
    timeoutMinutes?: number;
  }) {
    this.models.push([opts.stage, opts.model]);
    this.pinned.push([opts.stage, opts.agent, opts.timeoutMinutes]);
    this.resumed.push(opts.resume);
    this.rejects.push([opts.stage, opts.rejects]);
    this.scopes.push([opts.stage, opts.scope]);
    this.mcp.push([opts.stage, opts.mcp]);
    const key = `${opts.stage}:${opts.issue}`;
    const arr = this.queue.get(key);
    const next = arr?.shift();
    if (!next) throw new Error(`no executor registered for ${key}`);
    if (next.files) {
      const dir = join(opts.cwd, runDir(opts.issue));
      mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(next.files)) writeFileSync(join(dir, name), content);
    }
    return { ...(await next.executor.runStage(opts)), ...next.result };
  }
}

// One shared lease table, held to tests/ports/lease.contract.ts.
export class FakeLeases implements LeasePort {
  readonly table = new Map<string, LeaseRecord>();
  readonly log: string[] = [];
  async acquire(key: string, holder: string, ttlMs: number, now: number): Promise<boolean> {
    if (!mayTake(this.table.get(key), holder, now)) return false;
    this.table.set(key, { holder, expiresAt: now + ttlMs });
    this.log.push(`acquire ${key} ${holder}`);
    return true;
  }
  async release(key: string, holder: string): Promise<void> {
    if (this.table.get(key)?.holder !== holder) return;
    this.table.set(key, { holder, expiresAt: 0 });
    this.log.push(`release ${key} ${holder}`);
  }
}
