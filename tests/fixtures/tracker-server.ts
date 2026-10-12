// Tracker API v1 (docs/tracker-api.md), in memory: MemoryTracker is the fake
// TrackerPort, and startTracker serves the same store over HTTP as the reference
// server. A tracker that wants to drive the factory (kaas Tasks, a Linear bridge)
// can read this file as the spec in code. Every route is listed in SERVER_ROUTES.

import type { GhComment, GhIssue, RepoRole, TrackerPort } from "../../src/ports/scm";
import { assertCustomerSafe } from "../harness";

class NotFound extends Error {}

interface Project {
  issues: Map<number, GhIssue>;
  // Every label application, oldest first: what label-events answers from.
  events: { issue: number; label: string; actor: string }[];
  labels: Map<string, { color: string; description: string }>;
}

const ASSOCIATION: Record<RepoRole, string> = { admin: "OWNER", maintain: "MEMBER", write: "MEMBER", triage: "NONE", read: "NONE", none: "NONE" };

export class MemoryTracker implements TrackerPort {
  private readonly projects = new Map<string, Project>();
  private nextComment = 1;
  private tick = Date.parse("2026-01-01T00:00:00Z");

  // `login` is who the token belongs to; `members` are roles per login, across every project.
  constructor(
    readonly login = "factory-bot",
    readonly members = new Map<string, RepoRole>([["factory-bot", "admin"]]),
  ) {}

  private project(key: string): Project {
    let p = this.projects.get(key);
    if (!p) this.projects.set(key, (p = { issues: new Map(), events: [], labels: new Map() }));
    return p;
  }

  private issue(repo: string, n: number): GhIssue {
    const i = this.project(repo).issues.get(n);
    if (!i) throw new NotFound(`no issue ${n}`);
    return i;
  }

  private copy = (i: GhIssue): GhIssue => structuredClone(i);
  private open = (repo: string): GhIssue[] => [...this.project(repo).issues.values()].filter((i) => i.state === "OPEN");

  // A comment from anyone, as a human would leave one in the tracker's UI.
  say(repo: string, n: number, author: string, body: string): number {
    const id = this.nextComment++;
    const comment: GhComment = { id, author, authorAssociation: ASSOCIATION[this.members.get(author) ?? "none"], body, createdAt: new Date((this.tick += 1000)).toISOString() };
    this.issue(repo, n).comments.push(comment);
    return id;
  }

  // The one label edit: removes, then adds, recording who applied each new label.
  editLabels(repo: string, n: number, add: string[], remove: string[], actor = this.login): void {
    const issue = this.issue(repo, n);
    const p = this.project(repo);
    const names = issue.labels.map((l) => l.name).filter((l) => !remove.includes(l));
    for (const l of add) {
      if (!p.labels.has(l)) p.labels.set(l, { color: "ededed", description: "" });
      if (!names.includes(l)) {
        names.push(l);
        p.events.push({ issue: n, label: l, actor });
      }
    }
    issue.labels = names.map((name) => ({ name }));
  }

  async listIssuesByLabel(repo: string, label: string) {
    return this.open(repo).filter((i) => i.labels.some((l) => l.name === label)).map(this.copy);
  }
  async getIssue(repo: string, n: number) {
    return this.copy(this.issue(repo, n));
  }
  async listOpenIssues(repo: string) {
    return this.open(repo).map(this.copy);
  }
  async commentIssue(repo: string, n: number, body: string) {
    assertCustomerSafe(body);
    return this.say(repo, n, this.login, body);
  }
  async editComment(repo: string, id: number, body: string) {
    assertCustomerSafe(body);
    for (const i of this.project(repo).issues.values()) {
      const c = i.comments.find((x) => x.id === id);
      if (c) return void (c.body = body);
    }
    throw new NotFound(`no comment ${id}`);
  }
  async addLabels(repo: string, n: number, labels: string[]) {
    this.editLabels(repo, n, labels, []);
  }
  async removeLabels(repo: string, n: number, labels: string[]) {
    this.editLabels(repo, n, [], labels);
  }
  async setStateLabel(repo: string, n: number, current: string[], next: string) {
    this.editLabels(repo, n, [next], current.filter((l) => l !== next));
  }
  async closeIssue(repo: string, n: number) {
    Object.assign(this.issue(repo, n), { state: "CLOSED", stateReason: "COMPLETED" });
  }
  async reopenIssue(repo: string, n: number) {
    Object.assign(this.issue(repo, n), { state: "OPEN", stateReason: "REOPENED" });
  }
  async createIssue(repo: string, title: string, body: string, labels: string[]) {
    assertCustomerSafe(`${title}\n${body}`);
    const p = this.project(repo);
    const number = p.issues.size + 1;
    p.issues.set(number, { number, title, body, labels: [], comments: [], state: "OPEN", stateReason: null });
    this.editLabels(repo, number, labels, []);
    return number;
  }
  async listLabels(repo: string) {
    return [...this.project(repo).labels.keys()];
  }
  async ensureLabel(repo: string, name: string, color: string, description: string) {
    this.project(repo).labels.set(name, { color, description });
  }
  async currentLogin() {
    return this.login;
  }
  async labeledBy(repo: string, n: number, label: string) {
    this.issue(repo, n);
    return this.project(repo).events.filter((e) => e.issue === n && e.label === label).at(-1)?.actor;
  }
  async roleOf(_repo: string, login: string): Promise<RepoRole> {
    return this.members.get(login) ?? "none";
  }
  async authStatus() {
    return { ok: true, detail: `in memory as ${this.login}` };
  }
}

type Handler = (store: MemoryTracker, p: Record<string, string>, q: URLSearchParams, body: any) => Promise<unknown>;

// Method and path template under /tracker/v1, then what it does to the store.
const ROUTES: [string, Handler][] = [
  ["GET /me", async (s) => ({ login: await s.currentLogin() })],
  ["GET /projects/{project}/issues", async (s, p, q) => (q.get("label") ? s.listIssuesByLabel(p.project!, q.get("label")!) : s.listOpenIssues(p.project!))],
  ["GET /projects/{project}/issues/{n}", (s, p) => s.getIssue(p.project!, Number(p.n))],
  ["POST /projects/{project}/issues", async (s, p, _q, b) => ({ number: await s.createIssue(p.project!, b.title, b.body, b.labels ?? []) })],
  ["PATCH /projects/{project}/issues/{n}", async (s, p, _q, b) => ((b.state === "closed" ? await s.closeIssue(p.project!, Number(p.n)) : await s.reopenIssue(p.project!, Number(p.n))), {})],
  ["POST /projects/{project}/issues/{n}/comments", async (s, p, _q, b) => ({ id: await s.commentIssue(p.project!, Number(p.n), b.body) })],
  ["PATCH /projects/{project}/comments/{id}", async (s, p, _q, b) => (await s.editComment(p.project!, Number(p.id), b.body), {})],
  ["POST /projects/{project}/issues/{n}/labels", async (s, p, _q, b) => (s.editLabels(p.project!, Number(p.n), b.add ?? [], b.remove ?? []), {})],
  ["GET /projects/{project}/issues/{n}/label-events", async (s, p, q) => ({ actor: (await s.labeledBy(p.project!, Number(p.n), q.get("label") ?? "")) ?? null })],
  ["GET /projects/{project}/labels", (s, p) => s.listLabels(p.project!)],
  ["PUT /projects/{project}/labels/{name}", async (s, p, _q, b) => (await s.ensureLabel(p.project!, p.name!, b.color, b.description), {})],
  [
    "GET /projects/{project}/members/{login}",
    async (s, p) => {
      const role = await s.roleOf(p.project!, p.login!);
      if (role === "none") throw new NotFound(`${p.login} is not a member`);
      return { role };
    },
  ],
];

export const SERVER_ROUTES = ROUTES.map(([r]) => r);

const matchers = ROUTES.map(([route, handler]) => {
  const [method, template] = route.split(" ") as [string, string];
  const names: string[] = [];
  const re = new RegExp(`^/tracker/v1${template.replace(/\{(\w+)\}/g, (_, n: string) => (names.push(n), "([^/]+)"))}$`);
  return { method, re, names, handler };
});

export function startTracker(token: string, store = new MemoryTracker()) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "unauthorized" }, { status: 401 });
      const url = new URL(req.url);
      for (const m of matchers) {
        const hit = req.method === m.method && m.re.exec(url.pathname);
        if (!hit) continue;
        const params = Object.fromEntries(m.names.map((n, i) => [n, decodeURIComponent(hit[i + 1]!)]));
        try {
          return Response.json(await m.handler(store, params, url.searchParams, req.method === "GET" ? undefined : await req.json()));
        } catch (err) {
          const status = err instanceof NotFound ? 404 : 500;
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status });
        }
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, store, stop: () => server.stop(true) };
}
