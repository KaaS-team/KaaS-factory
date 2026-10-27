// The one place that shells out to `gh`. Injectable so tests never touch the network.

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface CommandRunner {
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<CommandResult>;
}

export class GhCommandRunner implements CommandRunner {
  async run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<CommandResult> {
    const proc = Bun.spawn(["gh", ...args], {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }
}

import { RateLimitError } from "./ports/scm";
import type {
  GhIssue,
  GhComment,
  CreatePrOptions,
  GhPr,
  CiCheck,
  PrStatus,
  MergeReadiness,
  RepoRole,
  ScmPort,
  TrackerPort,
  CodeHostPort,
} from "./ports/scm";
export type {
  GhIssue,
  GhComment,
  CreatePrOptions,
  GhPr,
  CiCheck,
  PrStatus,
  MergeReadiness,
  RepoRole,
  ScmPort,
  TrackerPort,
  CodeHostPort,
};

// gh prints a comment's author as {login}; everything past this file trusts a login string, and an
// object reached roleOf as "[object Object]", a 404, so no /factory approve was ever trusted.
type RawIssue = Omit<GhIssue, "comments"> & {
  comments?: (Omit<GhComment, "author"> & { author?: { login?: string } | string })[];
};
function issueFrom(raw: RawIssue): GhIssue {
  return {
    ...raw,
    comments: (raw.comments ?? []).map((c) => ({
      ...c,
      author: typeof c.author === "string" ? c.author : (c.author?.login ?? ""),
    })),
  };
}

class GhError extends Error {
  constructor(
    args: string[],
    public readonly result: CommandResult,
  ) {
    super(`gh ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
  }
}

export class GitHub implements TrackerPort, CodeHostPort {
  constructor(private readonly runner: CommandRunner = new GhCommandRunner()) {}

  private async exec(args: string[]): Promise<CommandResult> {
    const result = await this.runner.run(args);
    if (result.code !== 0) throw new GhError(args, result);
    return result;
  }

  async listIssuesByLabel(repo: string, label: string): Promise<GhIssue[]> {
    const result = await this.exec([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      label,
      "--state",
      "open",
      "--json",
      "number,title,body,labels,comments",
      // gh defaults to 30; a repo can carry far more than 30 ready issues at
      // once (audit: silently dropped tickets past the default).
      "--limit",
      "500",
    ]);
    return (JSON.parse(result.stdout || "[]") as RawIssue[]).map(issueFrom);
  }

  // One request for every label: gh's --label filter is AND, so list the open issues once and split by label here.
  // A 403/429 is a rate limit when the response says when it lifts; gh prints no headers for `issue list`, so the
  // reset time comes from the rate_limit endpoint's headers.
  async listIssuesByLabels(repo: string, labels: readonly string[]): Promise<Map<string, GhIssue[]>> {
    const result = await this.runner.run([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,title,body,labels,comments",
      "--limit",
      "500",
    ]);
    if (result.code !== 0) {
      const status = /HTTP (403|429)/.exec(result.stderr)?.[1];
      if (status) {
        const probe = await this.runner.run(["api", "--include", "rate_limit"]);
        const reset = /^x-ratelimit-reset:\s*(\d+)/im.exec(probe.stdout)?.[1];
        if (reset) throw new RateLimitError(Number(status), Number(reset));
      }
      throw new GhError(["issue", "list"], result);
    }
    const issues = (JSON.parse(result.stdout || "[]") as RawIssue[]).map(issueFrom);
    return new Map(labels.map((l) => [l, issues.filter((i) => i.labels.some((x) => x.name === l))]));
  }

  // Includes state/stateReason (blockers.ts's only reader of either field) so
  // a blocker check needs one call, not a separate `gh issue view --json state`.
  async getIssue(repo: string, number: number): Promise<GhIssue> {
    const result = await this.exec([
      "issue",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,title,body,labels,comments,state,stateReason",
    ]);
    return issueFrom(JSON.parse(result.stdout));
  }

  async listOpenIssues(repo: string): Promise<GhIssue[]> {
    const result = await this.exec([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,title,body,labels,comments",
      "--limit",
      "200",
    ]);
    return (JSON.parse(result.stdout || "[]") as RawIssue[]).map(issueFrom);
  }

  // Returns the new comment's id, parsed from the URL `gh` prints
  // (…#issuecomment-123456), so callers that need to edit it later (status
  // comments) can hold onto it.
  async commentIssue(repo: string, number: number, body: string): Promise<number | undefined> {
    const result = await this.exec(["issue", "comment", String(number), "--repo", repo, "--body", body]);
    const match = result.stdout.trim().match(/issuecomment-(\d+)/);
    return match ? Number(match[1]) : undefined;
  }

  async editComment(repo: string, commentId: number, body: string): Promise<void> {
    // `gh issue comment` can only edit the caller's last comment; a specific one needs the API.
    await this.exec(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`]);
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.exec(["issue", "edit", String(number), "--repo", repo, "--add-label", labels.join(",")]);
  }

  async removeLabels(repo: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.exec(["issue", "edit", String(number), "--repo", repo, "--remove-label", labels.join(",")]);
  }

  async setStateLabel(repo: string, number: number, current: string[], next: string): Promise<void> {
    const toRemove = current.filter((l) => l !== next);
    if (toRemove.length) await this.removeLabels(repo, number, toRemove);
    if (!current.includes(next)) await this.addLabels(repo, number, [next]);
  }

  async closeIssue(repo: string, number: number): Promise<void> {
    await this.exec(["issue", "close", String(number), "--repo", repo]);
  }

  async reopenIssue(repo: string, number: number): Promise<void> {
    await this.exec(["issue", "reopen", String(number), "--repo", repo]);
  }

  async labeledBy(repo: string, number: number, label: string): Promise<string | undefined> {
    // --paginate with --jq prints one login per labelled event, oldest first.
    const result = await this.exec([
      "api",
      "--paginate",
      `repos/${repo}/issues/${number}/events`,
      "--jq",
      `.[] | select(.event == "labeled" and .label.name == ${JSON.stringify(label)}) | .actor.login`,
    ]);
    return result.stdout.trim().split("\n").filter(Boolean).at(-1);
  }

  async roleOf(repo: string, login: string): Promise<RepoRole> {
    const result = await this.runner.run([
      "api",
      `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      "--jq",
      ".role_name // .permission",
    ]);
    // 404: not a collaborator at all. Any other failure is not an answer, so it throws.
    if (result.code !== 0 && /HTTP 404/.test(result.stderr)) return "none";
    if (result.code !== 0) throw new GhError(["api", "collaborators/permission"], result);
    const role = result.stdout.trim();
    return (["admin", "maintain", "write", "triage", "read"] as const).find((r) => r === role) ?? "none";
  }

  async createIssue(repo: string, title: string, body: string, labels: string[]): Promise<number> {
    const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
    for (const l of labels) args.push("--label", l);
    const result = await this.exec(args);
    const match = result.stdout.trim().match(/\/issues\/(\d+)/);
    if (!match) throw new Error(`could not parse issue number from: ${result.stdout}`);
    return Number(match[1]);
  }

  async createPr(opts: CreatePrOptions): Promise<string> {
    const args = [
      "pr",
      "create",
      "--repo",
      opts.repo,
      "--base",
      opts.base,
      "--head",
      opts.head,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ];
    if (opts.draft) args.push("--draft");
    const result = await this.exec(args);
    return result.stdout.trim().split("\n").pop() ?? "";
  }

  // A fork can name its branch factory/issue-N or write "Closes #N", so only PRs from this
  // repository are the factory's. Every PR lookup by head or issue goes through here.
  async listPrs(repo: string, opts?: { state?: string }): Promise<GhPr[]> {
    const result = await this.exec([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      opts?.state ?? "open",
      "--json",
      "number,url,state,headRefName,isDraft,closingIssuesReferences,isCrossRepository,updatedAt",
      "--limit",
      "100",
    ]);
    return (JSON.parse(result.stdout || "[]") as GhPr[]).filter((p) => p.isCrossRepository !== true);
  }

  async getPr(repo: string, number: number): Promise<GhPr> {
    const result = await this.exec([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,url,state,headRefName,isDraft,closingIssuesReferences",
    ]);
    return JSON.parse(result.stdout);
  }

  async findPrByHead(repo: string, head: string): Promise<GhPr | undefined> {
    const prs = await this.listPrs(repo, { state: "open" });
    return prs.find((p) => p.headRefName === head);
  }

  async mergedPrByHead(repo: string, head: string): Promise<GhPr | undefined> {
    const result = await this.exec([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      head,
      "--state",
      "merged",
      "--json",
      "number,url,state,headRefName,isDraft,closingIssuesReferences",
      "--limit",
      "1",
    ]);
    return (JSON.parse(result.stdout || "[]") as GhPr[]).find((p) => p.headRefName === head);
  }

  // Comments and review bodies on the PR, shaped like issue comments so the
  // same trust and command parsing applies. Empty when no PR exists yet.
  async prFeedback(repo: string, head: string): Promise<GhComment[]> {
    const result = await this.runner.run(["pr", "view", head, "--repo", repo, "--json", "comments,reviews"]);
    if (result.code !== 0) return [];
    const data = JSON.parse(result.stdout || "{}") as {
      comments?: { author?: { login?: string }; authorAssociation: string; body: string; createdAt: string }[];
      reviews?: { author?: { login?: string }; authorAssociation: string; body: string; submittedAt: string }[];
    };
    const toComment = (
      c: { author?: { login?: string }; authorAssociation: string; body: string },
      createdAt: string,
    ): GhComment => ({
      id: 0,
      author: c.author?.login ?? "",
      authorAssociation: c.authorAssociation,
      body: c.body,
      createdAt,
    });
    return [
      ...(data.comments ?? []).map((c) => toComment(c, c.createdAt)),
      ...(data.reviews ?? []).filter((r) => r.body).map((r) => toComment(r, r.submittedAt)),
    ];
  }

  // `ref` is a PR number or its head branch. Draft = the factory is working,
  // ready = a human's turn.
  async markReady(repo: string, ref: string | number, ready: boolean): Promise<void> {
    await this.exec(["pr", "ready", String(ref), "--repo", repo, ...(ready ? [] : ["--undo"])]);
  }

  async closePr(repo: string, number: number): Promise<void> {
    await this.exec(["pr", "close", String(number), "--repo", repo]);
  }

  // One `gh pr view` shape for validatePr and waitForCi (src/ci.ts); state is lowercased to match
  // GhPr.state's "open"/"closed" convention elsewhere in this codebase.
  async prStatus(repo: string, number: number): Promise<PrStatus> {
    const result = await this.exec([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "state,headRefOid,closingIssuesReferences,statusCheckRollup",
    ]);
    const data = JSON.parse(result.stdout) as {
      state: string;
      headRefOid: string;
      closingIssuesReferences?: { number: number }[];
      statusCheckRollup?: CiCheck[];
    };
    return {
      state: data.state.toLowerCase() as PrStatus["state"],
      headRefOid: data.headRefOid,
      closingIssuesReferences: data.closingIssuesReferences ?? [],
      statusCheckRollup: data.statusCheckRollup ?? [],
    };
  }

  // gate.py's Merge Readiness fields from `gh pr view`, plus review state, which only GraphQL has.
  // state is lowercased for the same reason as prStatus.
  async mergeReadiness(repo: string, number: number): Promise<MergeReadiness> {
    const result = await this.exec([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "state,isDraft,baseRefName,headRefOid,mergeable,reviewDecision",
    ]);
    const data = JSON.parse(result.stdout) as {
      state: string;
      isDraft: boolean;
      baseRefName: string;
      headRefOid: string;
      mergeable: string;
      reviewDecision: string;
    };
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new Error(`repo must be "owner/name", got ${JSON.stringify(repo)}`);
    const { hasUnresolvedReviewThreads, changesRequestedStale, approvedBy } = await this.reviewState(
      owner,
      name,
      number,
      data.headRefOid,
    );
    return {
      state: data.state.toLowerCase() as MergeReadiness["state"],
      isDraft: data.isDraft,
      baseRefName: data.baseRefName,
      headRefOid: data.headRefOid,
      mergeable: (data.mergeable || "UNKNOWN") as MergeReadiness["mergeable"],
      reviewDecision: (data.reviewDecision ?? "") as MergeReadiness["reviewDecision"],
      hasUnresolvedReviewThreads,
      changesRequestedStale,
      approvedBy,
    };
  }

  // One GraphQL call for what `gh pr view` can't expose: unresolved threads, stale change requests,
  // and who approved the head commit (gh's latestReviews leaves commit.oid empty).
  private async reviewState(
    owner: string,
    name: string,
    number: number,
    headRefOid: string,
  ): Promise<{ hasUnresolvedReviewThreads: boolean; changesRequestedStale: boolean; approvedBy: string[] }> {
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}reviews(last:50){nodes{state commit{oid}}}latestReviews(first:100){nodes{state author{login} commit{oid}}}}}}`;
    const vars = Object.entries({ owner, name, number }).flatMap(([k, v]) => ["-F", `${k}=${v}`]);
    const result = await this.exec(["api", "graphql", "-f", `query=${query}`, ...vars]);
    const data = JSON.parse(result.stdout) as {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: { isResolved: boolean }[] };
            reviews: { nodes: { state: string; commit: { oid: string } | null }[] };
            latestReviews?: {
              nodes: { state: string; author: { login: string } | null; commit: { oid: string } | null }[];
            };
          };
        };
      };
    };
    const pr = data.data.repository.pullRequest;
    const changesRequested = pr.reviews.nodes.filter((r) => r.state === "CHANGES_REQUESTED");
    return {
      hasUnresolvedReviewThreads: pr.reviewThreads.nodes.some((t) => !t.isResolved),
      changesRequestedStale: changesRequested.length > 0 && changesRequested.every((r) => r.commit?.oid !== headRefOid),
      approvedBy: (pr.latestReviews?.nodes ?? [])
        .filter((r) => r.state === "APPROVED" && r.commit?.oid === headRefOid)
        .map((r) => r.author?.login ?? ""),
    };
  }

  // The literal diff a human would read on the PR's "Files changed" tab.
  async prDiff(repo: string, prNumber: number): Promise<string> {
    const result = await this.exec(["pr", "diff", String(prNumber), "--repo", repo]);
    return result.stdout;
  }

  // The one open PR that closes this issue, if any, shared by watch.ts's
  // "someone else already closes this issue" triage check and the dashboard's
  // review view, so the lookup is defined in exactly one place.
  async prForIssue(repo: string, issueNumber: number, opts?: { excludeHead?: string }): Promise<GhPr | undefined> {
    const prs = await this.listPrs(repo, { state: "open" });
    return prs.find(
      (p) =>
        (!opts?.excludeHead || p.headRefName !== opts.excludeHead) &&
        p.closingIssuesReferences?.some((r) => r.number === issueNumber),
    );
  }

  // --squash --match-head-commit refuses the merge if the PR's head moved
  // since headSha was read, so a stale readiness snapshot never merges the
  // wrong commit. Never --admin: a branch-protection block is respected.
  async mergePr(repo: string, number: number, headSha: string): Promise<void> {
    await this.exec(["pr", "merge", String(number), "--repo", repo, "--squash", "--match-head-commit", headSha]);
  }

  async listLabels(repo: string): Promise<string[]> {
    const result = await this.exec(["label", "list", "--repo", repo, "--json", "name", "--limit", "200"]);
    const rows = JSON.parse(result.stdout || "[]") as { name: string }[];
    return rows.map((r) => r.name);
  }

  async ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
    const result = await this.runner.run([
      "label",
      "create",
      name,
      "--repo",
      repo,
      "--color",
      color,
      "--description",
      description,
      "--force",
    ]);
    if (result.code !== 0 && !result.stderr.includes("already exists")) {
      throw new GhError(["label", "create", name], result);
    }
  }

  async currentLogin(): Promise<string> {
    const result = await this.exec(["api", "user", "--jq", ".login"]);
    return result.stdout.trim();
  }

  // Unlike the methods above, a failed `gh auth status` is an expected,
  // reportable outcome (doctor finding #13 wants a real check here), not an
  // exceptional one: so this calls the runner directly instead of `exec`,
  // which would throw.
  async authStatus(): Promise<{ ok: boolean; detail: string }> {
    const result = await this.runner.run(["auth", "status"]);
    const firstLine = (result.stdout + result.stderr).trim().split("\n")[0] ?? "";
    return { ok: result.code === 0, detail: firstLine || "gh auth status failed with no output" };
  }
}
