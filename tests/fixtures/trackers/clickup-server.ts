// A stand-in for ClickUp's API v2, answering the routes ClickUpTracker calls with the shapes
// developer.clickup.com documents: base-36 task ids, decimal comment ids, lowercase space tags, and
// comments newest first. It drops HTML comments from stored text, as ClickUp's editor may.

interface Task {
  id: string;
  list: string;
  name: string;
  markdown_description: string;
  status: string;
  tags: string[];
  creator: number;
  comments: { id: string; comment_text: string; date: string; user: number }[];
}

const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
const STATUSES = [
  { status: "to do", type: "open" },
  { status: "in progress", type: "custom" },
  { status: "cancelled", type: "closed" },
  { status: "complete", type: "closed" },
];
const err = (status: number, msg: string) => Response.json({ err: msg, ECODE: "ITEM_015" }, { status });

export class ClickUpStore {
  readonly members: { user: { id: number; role: number } }[] = [{ user: { id: 1001, role: 2 } }];
  readonly lists = new Map<string, { space: string }>();
  readonly spaceTags = new Map<string, string[]>();
  readonly tasks: Task[] = [];
  private tick = Date.parse("2026-01-01T00:00:00Z");
  private nextTask = Number.parseInt("86a0000", 36);
  private nextComment = 90_150_000_000;
  me = 1001;

  now = () => String((this.tick += 1000));

  addList(id: string): void {
    this.lists.set(id, { space: `s-${id}` });
    this.spaceTags.set(`s-${id}`, []);
  }

  private view(t: Task) {
    const status = STATUSES.find((s) => s.status === t.status)!;
    return { id: t.id, name: t.name, markdown_description: t.markdown_description, status, tags: t.tags.map((name) => ({ name })), creator: { id: t.creator }, list: { id: t.list } };
  }

  handle(method: string, path: string, body: Record<string, any>, q: URLSearchParams): Response {
    if (path === "user") return Response.json({ user: { id: this.me } });
    let m = /^team\/(\w+)$/.exec(path);
    if (m) return m[1] === "ws1" ? Response.json({ team: { id: "ws1", members: this.members } }) : err(401, "Team not authorized");
    m = /^space\/([^/]+)\/tag$/.exec(path);
    if (m) {
      const tags = this.spaceTags.get(m[1]!);
      if (!tags) return err(404, "Space not found");
      if (method === "GET") return Response.json({ tags: tags.map((name) => ({ name, tag_fg: "#000000", tag_bg: "#ededed" })) });
      const name = String(body.tag.name).toLowerCase();
      if (!tags.includes(name)) tags.push(name);
      return Response.json({});
    }
    m = /^list\/([^/]+)(\/task)?$/.exec(path);
    if (m) {
      const list = this.lists.get(m[1]!);
      if (!list) return err(404, "List not found");
      if (!m[2]) return Response.json({ id: m[1], space: { id: list.space }, statuses: STATUSES });
      if (method === "POST") {
        const t: Task = {
          id: (this.nextTask++).toString(36),
          list: m[1]!,
          name: body.name,
          markdown_description: strip(body.markdown_content ?? ""),
          status: "to do",
          tags: (body.tags ?? []).map((x: string) => x.toLowerCase()),
          creator: this.me,
          comments: [],
        };
        this.tasks.push(t);
        return Response.json(this.view(t));
      }
      const tag = q.get("tags[]");
      const rows = this.tasks.filter(
        (t) => t.list === m![1] && STATUSES.find((s) => s.status === t.status)!.type !== "closed" && (!tag || t.tags.includes(tag)),
      );
      return Response.json({ tasks: rows.map((t) => this.view(t)), last_page: true });
    }
    m = /^comment\/(\d+)$/.exec(path);
    if (m) {
      const c = this.tasks.flatMap((t) => t.comments).find((x) => x.id === m![1]);
      if (!c) return err(404, "Comment not found");
      c.comment_text = strip(body.comment_text);
      return Response.json({});
    }
    m = /^task\/([0-9a-z]+)(?:\/(comment|tag))?(?:\/(.+))?$/.exec(path);
    const t = m && this.tasks.find((x) => x.id === m![1]);
    if (!m || !t) return err(404, "Task not found");
    const [, , sub, arg] = m;
    if (!sub && method === "GET") return Response.json(this.view(t));
    if (!sub && method === "PUT") {
      if (body.status) t.status = body.status;
      return Response.json(this.view(t));
    }
    if (sub === "tag") {
      const name = decodeURIComponent(arg!).toLowerCase();
      if (method === "POST") {
        if (!this.spaceTags.get(this.lists.get(t.list)!.space)!.includes(name)) return err(400, "Tag not found");
        if (!t.tags.includes(name)) t.tags.push(name);
      } else t.tags = t.tags.filter((x) => x !== name);
      return Response.json({});
    }
    if (method === "GET") return Response.json({ comments: [...t.comments].reverse().map((c) => ({ ...c, user: { id: c.user } })) });
    const c = { id: String(this.nextComment++), comment_text: strip(body.comment_text), date: this.now(), user: this.me };
    t.comments.push(c);
    return Response.json({ id: Number(c.id), date: Number(c.date) });
  }
}

export function startClickUp(token: string, store = new ClickUpStore()) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("authorization") !== token) return err(401, "Token invalid");
      const url = new URL(req.url);
      const m = /^\/api\/v2\/(.+)$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const body = req.method === "GET" || req.method === "DELETE" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
      return store.handle(req.method, m[1]!, body, url.searchParams);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, store, stop: () => server.stop(true) };
}
