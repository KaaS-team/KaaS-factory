// TrackerPort over Tracker API v1 (docs/tracker-api.md): issues, comments and
// labels on any tracker that speaks it (kaas Tasks, or a bridge to a tracker with no native adapter).
// The bearer token is read from the env var named by tracker.tokenEnv on each
// call, so it is never in config, an argv or a log.

import type { GhComment, GhIssue, RepoRole, TrackerPort } from "../ports/scm";

export interface HttpTrackerSpec {
  readonly kind: "http";
  readonly url: string;
  readonly tokenEnv: string;
  readonly project?: string;
}

// The one route table: the client builds every request from it, the reference
// server (tests/fixtures/tracker-server.ts) serves it, and the docs table lists it
// (tests/tracker-contract.test.ts holds all three to each other). Paths are under /tracker/v1.
export const TRACKER_ROUTES = {
  listIssuesByLabel: "GET /projects/{project}/issues",
  getIssue: "GET /projects/{project}/issues/{n}",
  listOpenIssues: "GET /projects/{project}/issues",
  commentIssue: "POST /projects/{project}/issues/{n}/comments",
  editComment: "PATCH /projects/{project}/comments/{id}",
  addLabels: "POST /projects/{project}/issues/{n}/labels",
  removeLabels: "POST /projects/{project}/issues/{n}/labels",
  setStateLabel: "POST /projects/{project}/issues/{n}/labels",
  closeIssue: "PATCH /projects/{project}/issues/{n}",
  reopenIssue: "PATCH /projects/{project}/issues/{n}",
  createIssue: "POST /projects/{project}/issues",
  listLabels: "GET /projects/{project}/labels",
  ensureLabel: "PUT /projects/{project}/labels/{name}",
  currentLogin: "GET /me",
  labeledBy: "GET /projects/{project}/issues/{n}/label-events",
  roleOf: "GET /projects/{project}/members/{login}",
  authStatus: "GET /me",
} as const satisfies Record<Exclude<keyof TrackerPort, "listIssuesByLabels">, string>;

export const TRACKER_PREFIX = "/tracker/v1";

type Route = (typeof TRACKER_ROUTES)[keyof typeof TRACKER_ROUTES];
const ROLES: readonly RepoRole[] = ["admin", "maintain", "write", "triage", "read", "none"];

export class TrackerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// An issue as the API sends it, normalised to the shape the runner reads.
function toIssue(raw: Partial<GhIssue> & { comments?: GhComment[] }): GhIssue {
  return {
    number: Number(raw.number),
    title: raw.title ?? "",
    body: raw.body ?? "",
    labels: (raw.labels ?? []).map((l) => ({ name: l.name })),
    comments: (raw.comments ?? []).map((c) => ({
      id: Number(c.id),
      author: c.author,
      authorAssociation: c.authorAssociation,
      body: c.body,
      createdAt: c.createdAt,
    })),
    state: raw.state === "CLOSED" ? "CLOSED" : "OPEN",
    stateReason: raw.stateReason ?? null,
  };
}

export class HttpTracker implements TrackerPort {
  constructor(
    private readonly spec: HttpTrackerSpec,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async call<T>(
    route: Route,
    params: Record<string, string | number>,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const [method, template] = route.split(" ") as [string, string];
    const path = template.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(params[k])));
    const query = opts.query ? `?${new URLSearchParams(opts.query)}` : "";
    const where = `${method} ${path}`;
    const token = this.env[this.spec.tokenEnv];
    if (!token) throw new TrackerHttpError(`tracker ${this.spec.url}: env var ${this.spec.tokenEnv} is not set`, 0);
    const res = await fetch(`${this.spec.url.replace(/\/+$/, "")}${TRACKER_PREFIX}${path}${query}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        detail = (JSON.parse(text) as { error?: string }).error ?? detail;
      } catch {
        // not JSON: keep the text
      }
      throw new TrackerHttpError(`tracker ${where} answered ${res.status}: ${detail}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  // The project the tracker knows this repo by.
  private p(repo: string): string {
    return this.spec.project ?? repo;
  }

  async listIssuesByLabel(repo: string, label: string): Promise<GhIssue[]> {
    const rows = await this.call<GhIssue[]>(
      TRACKER_ROUTES.listIssuesByLabel,
      { project: this.p(repo) },
      { query: { state: "open", label } },
    );
    return rows.map(toIssue);
  }

  async getIssue(repo: string, number: number): Promise<GhIssue> {
    return toIssue(await this.call<GhIssue>(TRACKER_ROUTES.getIssue, { project: this.p(repo), n: number }));
  }

  async listOpenIssues(repo: string): Promise<GhIssue[]> {
    const rows = await this.call<GhIssue[]>(
      TRACKER_ROUTES.listOpenIssues,
      { project: this.p(repo) },
      { query: { state: "open" } },
    );
    return rows.map(toIssue);
  }

  async commentIssue(repo: string, number: number, body: string): Promise<number | undefined> {
    const r = await this.call<{ id?: number }>(
      TRACKER_ROUTES.commentIssue,
      { project: this.p(repo), n: number },
      { body: { body } },
    );
    return r.id === undefined ? undefined : Number(r.id);
  }

  async editComment(repo: string, commentId: number, body: string): Promise<void> {
    await this.call(TRACKER_ROUTES.editComment, { project: this.p(repo), id: commentId }, { body: { body } });
  }

  private async labels(repo: string, number: number, add: string[], remove: string[]): Promise<void> {
    if (add.length === 0 && remove.length === 0) return;
    await this.call(TRACKER_ROUTES.addLabels, { project: this.p(repo), n: number }, { body: { add, remove } });
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.labels(repo, number, labels, []);
  }

  async removeLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.labels(repo, number, [], labels);
  }

  // One request, so the issue is never seen with both labels or neither.
  async setStateLabel(repo: string, number: number, current: string[], next: string): Promise<void> {
    await this.labels(
      repo,
      number,
      current.includes(next) ? [] : [next],
      current.filter((l) => l !== next),
    );
  }

  async closeIssue(repo: string, number: number): Promise<void> {
    await this.call(TRACKER_ROUTES.closeIssue, { project: this.p(repo), n: number }, { body: { state: "closed" } });
  }

  async reopenIssue(repo: string, number: number): Promise<void> {
    await this.call(TRACKER_ROUTES.reopenIssue, { project: this.p(repo), n: number }, { body: { state: "open" } });
  }

  async createIssue(repo: string, title: string, body: string, labels: string[]): Promise<number> {
    const r = await this.call<{ number: number }>(
      TRACKER_ROUTES.createIssue,
      { project: this.p(repo) },
      { body: { title, body, labels } },
    );
    return Number(r.number);
  }

  async listLabels(repo: string): Promise<string[]> {
    return this.call<string[]>(TRACKER_ROUTES.listLabels, { project: this.p(repo) });
  }

  async ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
    await this.call(TRACKER_ROUTES.ensureLabel, { project: this.p(repo), name }, { body: { color, description } });
  }

  async currentLogin(): Promise<string> {
    return (await this.call<{ login: string }>(TRACKER_ROUTES.currentLogin, {})).login;
  }

  async labeledBy(repo: string, number: number, label: string): Promise<string | undefined> {
    const r = await this.call<{ actor: string | null }>(
      TRACKER_ROUTES.labeledBy,
      { project: this.p(repo), n: number },
      { query: { label } },
    );
    return r.actor ?? undefined;
  }

  async roleOf(repo: string, login: string): Promise<RepoRole> {
    try {
      const r = await this.call<{ role: string }>(TRACKER_ROUTES.roleOf, { project: this.p(repo), login });
      return ROLES.find((x) => x === r.role) ?? "none";
    } catch (err) {
      // 404: not a member. Any other failure is not an answer, so it throws.
      if (err instanceof TrackerHttpError && err.status === 404) return "none";
      throw err;
    }
  }

  // An expected, reportable outcome for doctor, so it never throws.
  async authStatus(): Promise<{ ok: boolean; detail: string }> {
    try {
      return { ok: true, detail: `${this.spec.url} as ${await this.currentLogin()}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
