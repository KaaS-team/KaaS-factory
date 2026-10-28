// The one resolver from config to the ScmPort the runner holds: a tracker for
// issues (GitHub, or Tracker API v1 over HTTP) and a code host for PRs (GitHub).
// Two things change when the tracker is not GitHub, and both are decided here:
//   - an issue's PR is the one on its head branch (issueBranch), not the one whose
//     "Closes #n" names it, since #n would point at a GitHub issue;
//   - a PR body says "Closes tracker issue n" instead of "Closes #n", the PR URL is
//     posted on the tracker issue, and a factory merge closes the tracker issue (a
//     human merge is noticed by the watcher, src/watch.ts recordMerge).
// The `labels` map is applied here too, on the tracker side only.

import type { FactoryConfig, TrackerConfig } from "./config";
import { GitHub } from "./github";
import { appFromEnv, ghRunner, rateBudget } from "./github-app";
import { issueBranch, issueOfBranch } from "./git";
import type {
  CodeHostPort,
  CreatePrOptions,
  GhComment,
  GhIssue,
  GhPr,
  MergeReadiness,
  PrStatus,
  RateBudget,
  RepoRole,
  ScmPort,
  TrackerPort,
} from "./ports/scm";
import { HttpTracker } from "./adapters/http-tracker";
import { AsanaTracker } from "./adapters/trackers/asana";
import { ClickUpTracker } from "./adapters/trackers/clickup";
import { JiraTracker } from "./adapters/trackers/jira";
import { LinearTracker } from "./adapters/trackers/linear";
import { PlaneTracker } from "./adapters/trackers/plane";

export const PR_LINK_MARKER = "<!-- factory:pr-link v1 -->";

// GitHub's closing keywords. In branch mode "Closes #12" would close GitHub's #12.
const CLOSING = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)#(\d+)\b/gi;
export function unlinkClosingKeywords(text: string): string {
  return text.replace(CLOSING, "$1$2tracker issue $3");
}

// Factory label names out, the team's names back in. Unmapped names pass through.
export class LabelMappedTracker implements TrackerPort {
  private readonly fwd: Map<string, string>;
  private readonly back: Map<string, string>;
  constructor(
    private readonly inner: TrackerPort,
    map: Readonly<Record<string, string>>,
  ) {
    // A `_`-prefixed key is a comment, as everywhere in config.json.
    this.fwd = new Map(Object.entries(map).filter(([k]) => !k.startsWith("_")));
    this.back = new Map([...this.fwd].map(([factory, team]) => [team, factory]));
  }
  private out = (l: string): string => this.fwd.get(l) ?? l;
  private in = (l: string): string => this.back.get(l) ?? l;
  private issue = (i: GhIssue): GhIssue => ({ ...i, labels: i.labels.map((l) => ({ name: this.in(l.name) })) });

  async listIssuesByLabel(repo: string, label: string): Promise<GhIssue[]> {
    return (await this.inner.listIssuesByLabel(repo, this.out(label))).map(this.issue);
  }
  // Present only when the inner tracker has one, so the watcher's fallback still sees a missing method.
  get listIssuesByLabels(): TrackerPort["listIssuesByLabels"] {
    const inner = this.inner.listIssuesByLabels?.bind(this.inner);
    if (!inner) return undefined;
    return async (repo, labels) => {
      const found = await inner(repo, labels.map(this.out));
      return new Map(labels.map((l) => [l, (found.get(this.out(l)) ?? []).map(this.issue)]));
    };
  }
  async getIssue(repo: string, number: number): Promise<GhIssue> {
    return this.issue(await this.inner.getIssue(repo, number));
  }
  async listOpenIssues(repo: string): Promise<GhIssue[]> {
    return (await this.inner.listOpenIssues(repo)).map(this.issue);
  }
  commentIssue(repo: string, number: number, body: string) {
    return this.inner.commentIssue(repo, number, body);
  }
  editComment(repo: string, commentId: number, body: string) {
    return this.inner.editComment(repo, commentId, body);
  }
  addLabels(repo: string, number: number, labels: string[]) {
    return this.inner.addLabels(repo, number, labels.map(this.out));
  }
  removeLabels(repo: string, number: number, labels: string[]) {
    return this.inner.removeLabels(repo, number, labels.map(this.out));
  }
  setStateLabel(repo: string, number: number, current: string[], next: string) {
    return this.inner.setStateLabel(repo, number, current.map(this.out), this.out(next));
  }
  closeIssue(repo: string, number: number) {
    return this.inner.closeIssue(repo, number);
  }
  reopenIssue(repo: string, number: number) {
    return this.inner.reopenIssue(repo, number);
  }
  createIssue(repo: string, title: string, body: string, labels: string[]) {
    return this.inner.createIssue(repo, title, body, labels.map(this.out));
  }
  async listLabels(repo: string): Promise<string[]> {
    return (await this.inner.listLabels(repo)).map(this.in);
  }
  ensureLabel(repo: string, name: string, color: string, description: string) {
    return this.inner.ensureLabel(repo, this.out(name), color, description);
  }
  currentLogin() {
    return this.inner.currentLogin();
  }
  labeledBy(repo: string, number: number, label: string) {
    return this.inner.labeledBy(repo, number, this.out(label));
  }
  roleOf(repo: string, login: string) {
    return this.inner.roleOf(repo, login);
  }
  authStatus() {
    return this.inner.authStatus();
  }
}

// "closes": the tracker is the code host's own (GitHub), so "Closes #n" links them.
// "branch": the tracker is elsewhere, so the head branch is the link.
export type IssueLink = "closes" | "branch";

export class ComposedScm implements ScmPort {
  constructor(
    readonly tracker: TrackerPort,
    readonly codeHost: CodeHostPort,
    readonly link: IssueLink,
    readonly trackerKind: TrackerConfig["kind"] = link === "closes" ? "github" : "http",
    private readonly rate?: (repo: string) => Promise<RateBudget>,
  ) {}

  // ---- tracker
  listIssuesByLabel(repo: string, label: string) {
    return this.tracker.listIssuesByLabel(repo, label);
  }
  get listIssuesByLabels(): TrackerPort["listIssuesByLabels"] {
    return this.tracker.listIssuesByLabels?.bind(this.tracker);
  }
  getIssue(repo: string, number: number) {
    return this.tracker.getIssue(repo, number);
  }
  listOpenIssues(repo: string) {
    return this.tracker.listOpenIssues(repo);
  }
  commentIssue(repo: string, number: number, body: string) {
    return this.tracker.commentIssue(repo, number, body);
  }
  editComment(repo: string, commentId: number, body: string) {
    return this.tracker.editComment(repo, commentId, body);
  }
  addLabels(repo: string, number: number, labels: string[]) {
    return this.tracker.addLabels(repo, number, labels);
  }
  removeLabels(repo: string, number: number, labels: string[]) {
    return this.tracker.removeLabels(repo, number, labels);
  }
  setStateLabel(repo: string, number: number, current: string[], next: string) {
    return this.tracker.setStateLabel(repo, number, current, next);
  }
  closeIssue(repo: string, number: number) {
    return this.tracker.closeIssue(repo, number);
  }
  reopenIssue(repo: string, number: number) {
    return this.tracker.reopenIssue(repo, number);
  }
  createIssue(repo: string, title: string, body: string, labels: string[]) {
    return this.tracker.createIssue(repo, title, body, labels);
  }
  listLabels(repo: string) {
    return this.tracker.listLabels(repo);
  }
  ensureLabel(repo: string, name: string, color: string, description: string) {
    return this.tracker.ensureLabel(repo, name, color, description);
  }
  currentLogin() {
    return this.tracker.currentLogin();
  }
  labeledBy(repo: string, number: number, label: string) {
    return this.tracker.labeledBy(repo, number, label);
  }
  roleOf(repo: string, login: string): Promise<RepoRole> {
    return this.tracker.roleOf(repo, login);
  }
  rateLimit(repo: string) {
    return this.rate ? this.rate(repo) : Promise.reject(new Error("no rate budget"));
  }
  // gh's auth: PRs need it whatever the tracker is. Doctor checks the tracker's own separately.
  authStatus() {
    return this.codeHost.authStatus();
  }

  // ---- code host
  // In branch mode a PR closes the tracker issue its head names, never what GitHub parsed from its body.
  private linked = (pr: GhPr): GhPr => {
    if (this.link === "closes") return pr;
    const n = issueOfBranch(pr.headRefName);
    return { ...pr, closingIssuesReferences: n === undefined ? [] : [{ number: n }] };
  };

  async createPr(opts: CreatePrOptions): Promise<string> {
    if (this.link === "closes") return this.codeHost.createPr(opts);
    const url = await this.codeHost.createPr({
      ...opts,
      title: unlinkClosingKeywords(opts.title),
      body: unlinkClosingKeywords(opts.body),
    });
    const n = issueOfBranch(opts.head);
    if (n !== undefined) await this.tracker.commentIssue(opts.repo, n, `Pull request: ${url}\n\n${PR_LINK_MARKER}`);
    return url;
  }
  async listPrs(repo: string, opts?: { state?: string }) {
    return (await this.codeHost.listPrs(repo, opts)).map(this.linked);
  }
  async getPr(repo: string, number: number) {
    return this.linked(await this.codeHost.getPr(repo, number));
  }
  async findPrByHead(repo: string, head: string) {
    const pr = await this.codeHost.findPrByHead(repo, head);
    return pr && this.linked(pr);
  }
  async mergedPrByHead(repo: string, head: string) {
    const pr = await this.codeHost.mergedPrByHead(repo, head);
    return pr && this.linked(pr);
  }
  prFeedback(repo: string, head: string): Promise<GhComment[]> {
    return this.codeHost.prFeedback(repo, head);
  }
  markReady(repo: string, ref: string | number, ready: boolean) {
    return this.codeHost.markReady(repo, ref, ready);
  }
  closePr(repo: string, number: number) {
    return this.codeHost.closePr(repo, number);
  }
  async prStatus(repo: string, number: number): Promise<PrStatus> {
    const status = await this.codeHost.prStatus(repo, number);
    if (this.link === "closes") return status;
    return { ...status, closingIssuesReferences: (await this.getPr(repo, number)).closingIssuesReferences ?? [] };
  }
  mergeReadiness(repo: string, number: number): Promise<MergeReadiness> {
    return this.codeHost.mergeReadiness(repo, number);
  }
  prDiff(repo: string, prNumber: number) {
    return this.codeHost.prDiff(repo, prNumber);
  }
  async prForIssue(repo: string, issueNumber: number, opts?: { excludeHead?: string }) {
    if (this.link === "closes") return this.codeHost.prForIssue(repo, issueNumber, opts);
    const head = issueBranch(issueNumber);
    return opts?.excludeHead === head ? undefined : this.findPrByHead(repo, head);
  }
  // GitHub closes a "Closes #n" issue on merge by itself; a tracker elsewhere is told here.
  async mergePr(repo: string, number: number, headSha: string): Promise<void> {
    await this.codeHost.mergePr(repo, number, headSha);
    if (this.link === "closes") return;
    const n = issueOfBranch((await this.codeHost.getPr(repo, number)).headRefName);
    if (n !== undefined) await this.tracker.closeIssue(repo, n);
  }
}

// The tracker config names, built. `env` is where http's token is read from.
export function makeTracker(
  tracker: TrackerConfig,
  env: NodeJS.ProcessEnv = process.env,
  github: GitHub = new GitHub(),
): TrackerPort {
  switch (tracker.kind) {
    case "github":
      return github;
    case "http":
      return new HttpTracker(tracker, env);
    case "linear":
      return new LinearTracker(tracker, env);
    case "plane":
      return new PlaneTracker(tracker, env);
    case "jira":
      return new JiraTracker(tracker, env);
    case "clickup":
      return new ClickUpTracker(tracker, env);
    case "asana":
      return new AsanaTracker(tracker, env);
  }
}

export function makeScm(
  config: Pick<FactoryConfig, "tracker" | "labels">,
  env: NodeJS.ProcessEnv = process.env,
): ComposedScm {
  const github = new GitHub(ghRunner(env));
  const base = makeTracker(config.tracker, env, github);
  const tracker = Object.keys(config.labels).length ? new LabelMappedTracker(base, config.labels) : base;
  const link = config.tracker.kind === "github" ? "closes" : "branch";
  return new ComposedScm(tracker, github, link, config.tracker.kind, (repo) => rateBudget(repo, appFromEnv(env)));
}
