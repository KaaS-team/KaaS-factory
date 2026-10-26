// A stand-in for Asana's API 1.0, answering the routes AsanaTracker calls with the shapes
// developers.asana.com documents: {data} envelopes, decimal gids, workspace tags, and stories for
// comments and tag changes. It drops HTML comments from stored text, as Asana's editor may.

interface Task {
  gid: string;
  project: string;
  name: string;
  notes: string;
  completed: boolean;
  tags: string[];
  created_by: string;
}
interface Story {
  gid: string;
  task: string;
  resource_subtype: string;
  text: string;
  created_at: string;
  created_by: string;
  tag?: string;
}

const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
const ok = (data: unknown, status = 200) => Response.json({ data }, { status });
const err = (status: number, message: string) => Response.json({ errors: [{ message }] }, { status });

export class AsanaStore {
  readonly members = new Map<string, { is_admin: boolean; is_guest: boolean; is_active: boolean }>([
    ["1200000000000001", { is_admin: true, is_guest: false, is_active: true }],
  ]);
  readonly projects = new Set<string>();
  readonly tags: { gid: string; name: string }[] = [];
  readonly tasks: Task[] = [];
  readonly stories: Story[] = [];
  private tick = Date.parse("2026-01-01T00:00:00Z");
  private nextGid = 1_205_000_000_000_000;
  me = "1200000000000001";

  now = () => new Date((this.tick += 1000)).toISOString();
  gid = () => String(this.nextGid++);

  // A tag added by someone in the UI: what labeledBy must name.
  addTag(task: Task, tag: string, actor: string): void {
    if (!task.tags.includes(tag)) task.tags.push(tag);
    const name = this.tags.find((t) => t.gid === tag)!.name;
    this.stories.push({ gid: this.gid(), task: task.gid, resource_subtype: "added_to_tag", text: `added to ${name}`, created_at: this.now(), created_by: actor, tag });
  }

  private view(t: Task) {
    return { gid: t.gid, name: t.name, notes: t.notes, completed: t.completed, tags: t.tags.map((g) => this.tags.find((x) => x.gid === g)!), created_by: { gid: t.created_by }, projects: [{ gid: t.project }] };
  }

  handle(method: string, path: string, data: Record<string, any>, q: URLSearchParams): Response {
    if (path === "users/me") return ok({ gid: this.me });
    let m = /^workspaces\/ws1\/(tags|workspace_memberships)$/.exec(path);
    if (m?.[1] === "tags") return Response.json({ data: this.tags, next_page: null });
    if (m) {
      const u = this.members.get(q.get("user") ?? "");
      return Response.json({ data: u ? [u] : [], next_page: null });
    }
    if (path === "tags" && method === "POST") {
      const t = { gid: this.gid(), name: data.name };
      this.tags.push(t);
      return ok(t, 201);
    }
    m = /^projects\/(\d+)(\/tasks)?$/.exec(path);
    if (m) {
      if (!this.projects.has(m[1]!)) return err(404, "project: Not Found");
      if (!m[2]) return ok({ gid: m[1], name: "Shop" });
      const since = q.get("completed_since") === "now";
      const rows = this.tasks.filter((t) => t.project === m![1] && (!since || !t.completed));
      return Response.json({ data: rows.map((t) => this.view(t)), next_page: null });
    }
    if (path === "tasks" && method === "POST") {
      // Tags set at creation leave no story here, so labeledBy must fall back to the creator.
      const t: Task = { gid: this.gid(), project: data.projects[0], name: data.name, notes: strip(data.notes ?? ""), completed: false, tags: [...(data.tags ?? [])], created_by: this.me };
      this.tasks.push(t);
      return ok(this.view(t), 201);
    }
    m = /^stories\/(\d+)$/.exec(path);
    if (m) {
      const s = this.stories.find((x) => x.gid === m![1] && x.resource_subtype === "comment_added");
      if (!s) return err(404, "story: Not Found");
      if (s.created_by !== this.me) return err(403, "Forbidden");
      s.text = strip(data.text);
      return ok({ gid: s.gid });
    }
    m = /^tasks\/(\d+)(?:\/(stories|addTag|removeTag))?$/.exec(path);
    const t = m && this.tasks.find((x) => x.gid === m![1]);
    if (!m || !t) return err(404, "task: Not Found");
    const sub = m[2];
    if (!sub && method === "GET") return ok(this.view(t));
    if (!sub && method === "PUT") {
      if (typeof data.completed === "boolean") t.completed = data.completed;
      if (typeof data.notes === "string") t.notes = strip(data.notes);
      return ok(this.view(t));
    }
    if (sub === "addTag") {
      if (!this.tags.some((x) => x.gid === data.tag)) return err(400, "tag: Not a recognized ID");
      this.addTag(t, data.tag, this.me);
      return ok({});
    }
    if (sub === "removeTag") {
      t.tags = t.tags.filter((g) => g !== data.tag);
      return ok({});
    }
    if (method === "GET") {
      const rows = this.stories.filter((s) => s.task === t.gid).map((s) => ({ ...s, created_by: { gid: s.created_by }, tag: s.tag ? { gid: s.tag } : null }));
      return Response.json({ data: rows, next_page: null });
    }
    const s: Story = { gid: this.gid(), task: t.gid, resource_subtype: "comment_added", text: strip(data.text), created_at: this.now(), created_by: this.me };
    this.stories.push(s);
    return ok({ gid: s.gid }, 201);
  }
}

export function startAsana(token: string, store = new AsanaStore()) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${token}`) return err(401, "Not Authorized");
      const url = new URL(req.url);
      const m = /^\/(.+)$/.exec(url.pathname);
      const body = req.method === "GET" ? {} : ((await req.json()) as { data: Record<string, unknown> });
      return store.handle(req.method, m![1]!, (body as { data?: Record<string, unknown> }).data ?? {}, url.searchParams);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, store, stop: () => server.stop(true) };
}
