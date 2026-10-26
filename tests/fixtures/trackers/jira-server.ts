// A stand-in for Jira's REST API v2, answering the routes JiraTracker calls with the shapes
// developer.atlassian.com documents. It drops HTML comments from stored text, as a wiki renderer may.

interface Issue {
  key: string;
  summary: string;
  description: string;
  labels: string[];
  status: string;
  resolution: string | null;
  creator: string;
  comments: { id: string; body: string; created: string; author: string }[];
  changelog: { author: string; created: string; items: { field: string; fromString: string; toString: string }[] }[];
}

const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
// One workflow for every project: each status can move to every other.
const STATUSES: Record<string, string> = { "To Do": "new", "In Progress": "indeterminate", Done: "done" };
const notFound = (what: string) => Response.json({ errorMessages: [`${what} does not exist`] }, { status: 404 });

export class JiraStore {
  readonly projects = new Map<string, { id: number; issues: Issue[]; perms: Map<string, string[]> }>();
  private tick = Date.parse("2026-01-01T00:00:00Z");
  private nextId = 10_000;
  me = "acc-factory-bot";

  now = () => new Date((this.tick += 1000)).toISOString().replace("Z", "+0000");

  addProject(key: string) {
    const p = { id: ++this.nextId, issues: [] as Issue[], perms: new Map([[this.me, ["ADMINISTER_PROJECTS", "EDIT_ISSUES", "BROWSE_PROJECTS"]]]) };
    this.projects.set(key, p);
    return p;
  }

  private issue(key: string): Issue | undefined {
    return this.projects.get(key.split("-")[0]!)?.issues.find((i) => i.key === key);
  }

  // A label added by someone in the UI: what labeledBy must name.
  setLabels(i: Issue, next: string[], actor: string): void {
    if (next.join(" ") !== i.labels.join(" "))
      i.changelog.push({ author: actor, created: this.now(), items: [{ field: "labels", fromString: i.labels.join(" "), toString: next.join(" ") }] });
    i.labels = next;
  }

  private view(i: Issue) {
    return {
      key: i.key,
      fields: {
        summary: i.summary,
        description: i.description || null,
        labels: i.labels,
        status: { name: i.status, statusCategory: { key: STATUSES[i.status] } },
        resolution: i.resolution ? { name: i.resolution } : null,
        creator: { accountId: i.creator },
      },
    };
  }

  handle(method: string, path: string, body: Record<string, any>, q: URLSearchParams): Response {
    const startAt = Number(q.get("startAt") ?? 0);
    const paged = (field: string, rows: unknown[]) => Response.json({ [field]: rows.slice(startAt), startAt, total: rows.length, isLast: true });
    if (path === "myself") return Response.json({ accountId: this.me });
    if (path === "label") return paged("values", [...new Set([...this.projects.values()].flatMap((p) => p.issues.flatMap((i) => i.labels)))]);
    if (path === "permissions/check") {
      const all = [...this.projects.values()];
      if (!all.some((p) => p.perms.has(body.accountId))) return Response.json({ errorMessages: ["user not found"] }, { status: 400 });
      const asked = body.projectPermissions[0] as { permissions: string[]; projects: number[] };
      return Response.json({
        projectPermissions: asked.permissions.map((permission) => ({
          permission,
          projects: all.filter((p) => asked.projects.includes(p.id) && p.perms.get(body.accountId)?.includes(permission)).map((p) => p.id),
        })),
      });
    }
    if (path === "search/jql") {
      const m = /^project = "([^"]+)" AND statusCategory != Done(?: AND labels = "([^"]+)")? ORDER BY created ASC$/.exec(body.jql);
      if (!m) return Response.json({ errorMessages: [`unsupported jql ${body.jql}`] }, { status: 400 });
      const rows = (this.projects.get(m[1]!)?.issues ?? []).filter((i) => STATUSES[i.status] !== "done" && (!m[2] || i.labels.includes(m[2])));
      return Response.json({ issues: rows.map((i) => this.view(i)), isLast: true });
    }
    let m = /^project\/([^/]+)$/.exec(path);
    if (m) {
      const p = this.projects.get(m[1]!);
      return p ? Response.json({ id: String(p.id), key: m[1] }) : notFound("Project");
    }
    if (path === "issue" && method === "POST") {
      const f = body.fields;
      const p = this.projects.get(f.project.key);
      if (!p) return notFound("Project");
      const key = `${f.project.key}-${p.issues.length + 1}`;
      // Labels set at creation leave no changelog entry, as in Jira.
      p.issues.push({ key, summary: f.summary, description: strip(f.description ?? ""), labels: [...(f.labels ?? [])], status: "To Do", resolution: null, creator: this.me, comments: [], changelog: [] });
      return Response.json({ id: String(this.nextId++), key }, { status: 201 });
    }
    m = /^issue\/([^/]+)(?:\/(comment|transitions|changelog))?(?:\/([^/]+))?$/.exec(path);
    const i = m && this.issue(m[1]!);
    if (!m || !i) return notFound("Issue");
    const [, , sub, subId] = m;
    if (!sub && method === "GET") return Response.json(this.view(i));
    if (!sub && method === "PUT") {
      if (typeof body.fields?.description === "string") i.description = strip(body.fields.description);
      let next = [...i.labels];
      for (const op of body.update?.labels ?? []) {
        if (op.add && !next.includes(op.add)) next.push(op.add);
        if (op.remove) next = next.filter((l) => l !== op.remove);
      }
      this.setLabels(i, next, this.me);
      return new Response(null, { status: 204 });
    }
    if (sub === "changelog") return paged("values", i.changelog.map((h) => ({ ...h, author: { accountId: h.author } })));
    if (sub === "transitions" && method === "GET")
      return Response.json({ transitions: Object.entries(STATUSES).filter(([s]) => s !== i.status).map(([name, key], n) => ({ id: String(n + 11), name, to: { name, statusCategory: { key } } })) });
    if (sub === "transitions" && method === "POST") {
      const target = Object.keys(STATUSES).filter((s) => s !== i.status)[Number(body.transition.id) - 11];
      if (!target) return Response.json({ errorMessages: ["bad transition"] }, { status: 400 });
      i.status = target;
      i.resolution = STATUSES[target] === "done" ? "Done" : null;
      return new Response(null, { status: 204 });
    }
    if (sub === "comment" && !subId && method === "GET") return paged("comments", i.comments.map((c) => ({ ...c, author: { accountId: c.author } })));
    if (sub === "comment" && !subId && method === "POST") {
      const c = { id: String(this.nextId++), body: strip(body.body), created: this.now(), author: this.me };
      i.comments.push(c);
      return Response.json({ id: c.id }, { status: 201 });
    }
    const c = i.comments.find((x) => x.id === subId);
    if (sub === "comment" && c && method === "PUT") {
      c.body = strip(body.body);
      return Response.json({ id: c.id });
    }
    return notFound("Comment");
  }
}

export function startJira(token: string, store = new JiraStore()) {
  const expected = `Basic ${Buffer.from(token).toString("base64")}`;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("authorization") !== expected) return new Response("Unauthorized", { status: 401 });
      const url = new URL(req.url);
      const m = /^\/rest\/api\/2\/(.+)$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const body = req.method === "GET" ? {} : ((await req.json()) as Record<string, unknown>);
      return store.handle(req.method, m[1]!, body, url.searchParams);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, store, stop: () => server.stop(true) };
}
