// A stand-in for Linear's GraphQL API, answering each named operation LinearTracker sends with the
// response shape Linear documents. Like Linear's editor may, it drops HTML comments from every body
// it stores, so the marker codec is what carries the runner's markers through.

import { randomUUID } from "node:crypto";

interface User {
  id: string;
  admin: boolean;
  guest: boolean;
  active: boolean;
}
interface Issue {
  id: string;
  team: string;
  number: number;
  title: string;
  description: string;
  stateId: string;
  creator: string;
  labelIds: string[];
  comments: { id: string; body: string; createdAt: string; user: string }[];
  history: { createdAt: string; actor: string; addedLabelIds: string[] }[];
}

const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

export class LinearStore {
  readonly users = new Map<string, User>([["factory-bot", { id: "factory-bot", admin: true, guest: false, active: true }]]);
  readonly teams = new Map<string, { id: string; key: string; states: { id: string; type: string; position: number }[] }>();
  readonly labels: { id: string; name: string; team: string | null }[] = [];
  readonly issues: Issue[] = [];
  private tick = Date.parse("2026-01-01T00:00:00Z");
  viewer = "factory-bot";

  now = () => new Date((this.tick += 1000)).toISOString();

  addTeam(key: string): void {
    const states = ["backlog", "unstarted", "started", "completed", "canceled"].map((type, position) => ({ id: randomUUID(), type, position }));
    this.teams.set(key, { id: randomUUID(), key, states });
  }

  private find(idOrKey: string): Issue | undefined {
    return this.issues.find((i) => i.id === idOrKey || `${this.teamById(i.team).key}-${i.number}` === idOrKey);
  }
  private teamById = (id: string) => [...this.teams.values()].find((t) => t.id === id)!;

  private view(i: Issue) {
    const state = this.teamById(i.team).states.find((s) => s.id === i.stateId)!;
    return {
      id: i.id,
      number: i.number,
      title: i.title,
      description: i.description,
      state: { type: state.type },
      creator: { id: i.creator },
      labels: { nodes: i.labelIds.map((id) => this.labels.find((l) => l.id === id)!).map((l) => ({ id: l.id, name: l.name })) },
      comments: { nodes: i.comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, user: { id: c.user } })) },
    };
  }

  // Labels added by someone in the UI: what labeledBy must name.
  applyLabel(issueId: string, labelId: string, actor: string): void {
    const i = this.find(issueId)!;
    if (!i.labelIds.includes(labelId)) i.labelIds.push(labelId);
    i.history.push({ createdAt: this.now(), actor, addedLabelIds: [labelId] });
  }

  // One operation by name; a thrown Error is a GraphQL error, as Linear reports one.
  run(name: string, v: Record<string, any>): unknown {
    switch (name) {
      case "Viewer":
        return { viewer: { id: this.viewer } };
      case "Team":
        return { teams: { nodes: [...this.teams.values()].filter((t) => t.key === v.key).map((t) => ({ id: t.id, states: { nodes: t.states } })) } };
      case "Issue": {
        const i = this.find(v.id);
        return { issue: i ? this.view(i) : null };
      }
      case "Issues": {
        const f = v.filter;
        const team = this.teams.get(f.team.key.eq)!;
        const rows = this.issues.filter((i) => {
          if (i.team !== team.id) return false;
          const type = team.states.find((s) => s.id === i.stateId)!.type;
          if (f.state?.type?.nin?.includes(type)) return false;
          if (f.labels?.name?.eq && !i.labelIds.some((id) => this.labels.find((l) => l.id === id)?.name === f.labels.name.eq)) return false;
          return true;
        });
        return { issues: { nodes: rows.map((i) => this.view(i)), pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      case "Labels":
        return { issueLabels: { nodes: this.labels.map((l) => ({ id: l.id, name: l.name, team: l.team ? { id: l.team } : null })), pageInfo: { hasNextPage: false, endCursor: null } } };
      case "History": {
        const i = this.find(v.id);
        if (!i) throw new Error("Entity not found");
        return { issue: { creator: { id: i.creator }, history: { nodes: i.history.map((h) => ({ createdAt: h.createdAt, actor: { id: h.actor }, addedLabelIds: h.addedLabelIds })) } } };
      }
      case "User": {
        const u = this.users.get(v.id);
        if (!u) throw new Error("Entity not found: User");
        return { user: u };
      }
      case "CommentCreate": {
        const i = this.find(v.input.issueId);
        if (!i) throw new Error("Entity not found: Issue");
        const c = { id: randomUUID(), body: strip(v.input.body), createdAt: this.now(), user: this.viewer };
        i.comments.push(c);
        return { commentCreate: { comment: { id: c.id } } };
      }
      case "CommentUpdate": {
        const c = this.issues.flatMap((i) => i.comments).find((x) => x.id === v.id);
        if (!c) throw new Error("Entity not found: Comment");
        c.body = strip(v.input.body);
        return { commentUpdate: { success: true } };
      }
      case "IssueCreate": {
        const team = this.teamById(v.input.teamId);
        const number = this.issues.filter((i) => i.team === team.id).length + 1;
        // Labels set at creation leave no history entry, as in Linear.
        this.issues.push({
          id: randomUUID(),
          team: team.id,
          number,
          title: v.input.title,
          description: strip(v.input.description ?? ""),
          stateId: team.states.find((s) => s.type === "backlog")!.id,
          creator: this.viewer,
          labelIds: [...(v.input.labelIds ?? [])],
          comments: [],
          history: [],
        });
        return { issueCreate: { issue: { number } } };
      }
      case "IssueUpdate": {
        const i = this.find(v.id);
        if (!i) throw new Error("Entity not found: Issue");
        if (v.input.stateId) i.stateId = v.input.stateId;
        for (const id of v.input.addedLabelIds ?? []) this.applyLabel(i.id, id, this.viewer);
        i.labelIds = i.labelIds.filter((id) => !(v.input.removedLabelIds ?? []).includes(id));
        return { issueUpdate: { success: true } };
      }
      case "LabelCreate": {
        const l = { id: randomUUID(), name: v.input.name, team: v.input.teamId ?? null };
        this.labels.push(l);
        return { issueLabelCreate: { issueLabel: { id: l.id, name: l.name } } };
      }
    }
    throw new Error(`unknown operation ${name}`);
  }
}

export function startLinear(token: string, store = new LinearStore()) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("authorization") !== token) return Response.json({ errors: [{ message: "Authentication required" }] }, { status: 401 });
      if (new URL(req.url).pathname !== "/graphql" || req.method !== "POST") return new Response("not found", { status: 404 });
      const { query, variables } = (await req.json()) as { query: string; variables: Record<string, unknown> };
      const name = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "";
      try {
        return Response.json({ data: store.run(name, variables ?? {}) });
      } catch (err) {
        return Response.json({ data: null, errors: [{ message: (err as Error).message }] });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, store, stop: () => server.stop(true) };
}
