// A stand-in for Plane's v2 REST API, answering the routes PlaneTracker calls with the shapes
// developers.plane.so documents. Like Plane's editor may, it drops HTML comments from stored HTML.

import { randomUUID } from "node:crypto";

interface Item {
  id: string;
  name: string;
  description_html: string;
  sequence_id: number;
  state_id: string;
  label_ids: string[];
  created_by_id: string;
  comments: { id: string; comment_html: string; created_at: string; actor_id: string }[];
  activities: { actor_id: string; field: string; verb: string; old_value: string | null; new_value: string | null; old_identifier: string | null; new_identifier: string | null; created_at: string }[];
}
interface Project {
  states: { id: string; group: string }[];
  labels: { id: string; name: string }[];
  items: Item[];
  members: { member_id: string; role: number }[];
}

const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
const page = <T>(data: T[]) => Response.json({ data, next: null, total_count: data.length });

export class PlaneStore {
  readonly projects = new Map<string, Project>();
  private tick = Date.parse("2026-01-01T00:00:00Z");
  me = "factory-bot";

  now = () => new Date((this.tick += 1000)).toISOString();

  addProject(id: string): Project {
    const states = ["backlog", "unstarted", "started", "completed", "cancelled"].map((group) => ({ id: randomUUID(), group }));
    const p: Project = { states, labels: [], items: [], members: [{ member_id: this.me, role: 20 }] };
    this.projects.set(id, p);
    return p;
  }

  // A label added by someone in the UI: what labeledBy must name.
  applyLabel(item: Item, labelId: string, actor: string): void {
    const p = [...this.projects.values()].find((x) => x.items.includes(item))!;
    if (!item.label_ids.includes(labelId)) item.label_ids.push(labelId);
    const name = p.labels.find((l) => l.id === labelId)!.name;
    item.activities.push({ actor_id: actor, field: "labels", verb: "updated", old_value: null, new_value: name, old_identifier: null, new_identifier: labelId, created_at: this.now() });
  }

  handle(method: string, parts: string[], body: Record<string, any>, query: URLSearchParams): Response {
    if (parts.join("/") === "users/me") return Response.json({ id: this.me });
    // workspaces/<slug>/projects/<id>/<rest...>
    if (parts[0] !== "workspaces" || parts[2] !== "projects") return new Response("not found", { status: 404 });
    const p = this.projects.get(parts[3]!);
    if (!p) return Response.json({ error: "Project not found" }, { status: 404 });
    const [kind, id, sub, subId] = parts.slice(4);
    if (kind === "states") return page(p.states);
    if (kind === "members") return page(p.members);
    if (kind === "labels" && method === "GET") return page(p.labels);
    if (kind === "labels" && method === "POST") {
      if (p.labels.some((l) => l.name === body.name)) return Response.json({ error: "Label already exists" }, { status: 409 });
      const l = { id: randomUUID(), name: body.name as string };
      p.labels.push(l);
      return Response.json(l, { status: 201 });
    }
    if (kind !== "work-items") return new Response("not found", { status: 404 });
    if (!id && method === "GET") return page(p.items.map(view));
    if (!id && method === "POST") {
      // Labels set at creation leave no activity row here, so labeledBy must fall back to the creator.
      const w: Item = {
        id: randomUUID(),
        name: body.name,
        description_html: strip(body.description_html ?? ""),
        sequence_id: p.items.length + 1,
        state_id: p.states.find((s) => s.group === "backlog")!.id,
        label_ids: [...(body.label_ids ?? [])],
        created_by_id: this.me,
        comments: [],
        activities: [],
      };
      p.items.push(w);
      return Response.json(view(w), { status: 201 });
    }
    const w = p.items.find((x) => x.id === id);
    if (!w) return Response.json({ error: "Work item not found" }, { status: 404 });
    if (!sub && method === "GET") return Response.json(view(w));
    if (!sub && method === "PATCH") {
      if (body.state_id) w.state_id = body.state_id;
      if (body.label_ids) {
        const next: string[] = body.label_ids;
        for (const l of next.filter((x) => !w.label_ids.includes(x))) this.applyLabel(w, l, this.me);
        for (const l of w.label_ids.filter((x) => !next.includes(x))) {
          const name = p.labels.find((x) => x.id === l)!.name;
          w.activities.push({ actor_id: this.me, field: "labels", verb: "updated", old_value: name, new_value: "", old_identifier: l, new_identifier: null, created_at: this.now() });
        }
        w.label_ids = [...next];
      }
      return Response.json(view(w));
    }
    if (sub === "activities") return page(w.activities.filter((a) => !query.get("field") || a.field === query.get("field")));
    if (sub === "comments" && !subId && method === "GET") return page(w.comments);
    if (sub === "comments" && !subId && method === "POST") {
      const c = { id: randomUUID(), comment_html: strip(body.comment_html), created_at: this.now(), actor_id: this.me };
      w.comments.push(c);
      return Response.json(c, { status: 201 });
    }
    const c = w.comments.find((x) => x.id === subId);
    if (sub === "comments" && c && method === "PATCH") {
      c.comment_html = strip(body.comment_html);
      return Response.json(c);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}

function view(w: Item) {
  const { comments: _c, activities: _a, ...rest } = w;
  return rest;
}

export function startPlane(token: string, store = new PlaneStore()) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("x-api-key") !== token) return Response.json({ error: "Invalid API key" }, { status: 401 });
      const url = new URL(req.url);
      const m = /^\/api\/v2\/(.+?)\/?$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const body = req.method === "GET" ? {} : ((await req.json()) as Record<string, unknown>);
      return store.handle(req.method, m[1]!.split("/").map(decodeURIComponent), body, url.searchParams);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, store, stop: () => server.stop(true) };
}
