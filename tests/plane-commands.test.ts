// Structural: every command route posts its command as a comment on the issue, signed with the
// person who sent it, before it answers; a command the issue is not waiting for posts nothing.
import { describe, expect, test } from "bun:test";
import { createDashboard } from "../dashboard/server";
import { createAccess } from "../dashboard/plane/access";
import { COMMANDS } from "../dashboard/plane/commands";
import { PlaneStore, type Role } from "../dashboard/plane/store";
import { CONTROL_LABEL, webMode } from "../src/autonomy";
import { parseChatOps } from "../src/chatops";
import { GitHub } from "../src/github";
import { WAITING } from "../src/inbox";
import { LABEL } from "../src/labels";
import type { GhIssue } from "../src/ports/scm";
import { FactoryState } from "../src/state";

const TOKEN = "break-glass-token";
const BASE = "http://localhost:4100";

class TrackerGitHub extends GitHub {
  label: string = LABEL.awaitingApproval;
  posted: { issue: number; body: string }[] = [];
  created: { title: string; body: string; labels: string[] }[] = [];
  override async getIssue(_repo: string, number: number): Promise<GhIssue> {
    return { number, title: "t", body: "", labels: [{ name: this.label }], comments: [] };
  }
  override async listOpenIssues() {
    return [];
  }
  override async listPrs() {
    return [];
  }
  override async commentIssue(_repo: string, issue: number, body: string) {
    this.posted.push({ issue, body });
    return this.posted.length;
  }
  override async createIssue(_repo: string, title: string, body: string, labels: string[]) {
    this.created.push({ title, body, labels });
    return 40 + this.created.length;
  }
}

function make() {
  const store = new PlaneStore();
  const github = new TrackerGitHub();
  const access = createAccess({ token: TOKEN, store, env: {} });
  const dashboard = createDashboard(
    new FactoryState(":memory:"),
    github,
    "acme/widgets",
    false,
    "/nonexistent",
    undefined,
    undefined,
    undefined,
    access,
  );
  // A member's session, opened the way sign-in opens one.
  const as = (role: Role) => {
    store.setMember(`${role}-person`, role, "test");
    const id = crypto.randomUUID();
    store.openSession(id, `${role}-person`, 60_000);
    return `factory_session=${id}`;
  };
  // A value with a space is an Authorization header; anything else is a session cookie.
  const post = (path: string, cookie: string, body: unknown = {}) =>
    dashboard.handle(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie.includes(" ") ? { authorization: cookie } : { cookie }),
        },
        body: JSON.stringify(body),
      }),
      "127.0.0.1",
    );
  return { github, store, as, post };
}

// The label each command is offered on, from the inbox table the runner's own CLI uses.
const labelFor = (action: string) => Object.entries(WAITING).find(([, w]) => w.actions.includes(action as never))![0];

describe("command routes", () => {
  test("each command is a signed comment on the issue before the route answers", async () => {
    for (const [name, { action }] of Object.entries(COMMANDS)) {
      const p = make();
      p.github.label = labelFor(action);
      const res = await p.post(`/api/issues/7/${name}`, p.as("operator"), { text: "use the cache" });
      expect(res.status, name).toBe(200);
      expect(p.github.posted, name).toHaveLength(1);
      const { issue, body } = p.github.posted[0]!;
      expect(issue).toBe(7);
      expect(body, name).toContain("Sent from the factory control plane by @operator-person");
      expect(parseChatOps(body).type, name).toBe(action);
      expect(p.store.audit()[0], name).toMatchObject({
        actor: "operator-person",
        route: `POST /api/issues/:n/${name}`,
        issue: 7,
        status: 200,
      });
    }
  });

  test("a command the issue is not waiting for posts nothing", async () => {
    const p = make();
    p.github.label = LABEL.building;
    expect((await p.post("/api/issues/7/approve-plan", p.as("operator"))).status).toBe(409);
    p.github.label = LABEL.needsInfo;
    expect((await p.post("/api/issues/7/approve-plan", p.as("operator"))).status).toBe(409);
    expect(p.github.posted).toHaveLength(0);
  });

  test("an approver may approve a plan and nothing else", async () => {
    const p = make();
    const cookie = p.as("approver");
    expect((await p.post("/api/issues/7/approve-plan", cookie)).status).toBe(200);
    expect((await p.post("/api/issues/7/revise", cookie, { text: "smaller" })).status).toBe(403);
    expect((await p.post("/api/issues/7/approve-plan", p.as("viewer"))).status).toBe(403);
    expect(p.github.posted).toHaveLength(1);
  });

  test("revise and answer need words, and the signature never becomes part of them", async () => {
    const p = make();
    const cookie = p.as("operator");
    expect((await p.post("/api/issues/7/revise", cookie, { text: "  " })).status).toBe(400);
    expect((await p.post("/api/issues/7/revise", cookie, { text: "drop the migration" })).status).toBe(200);
    expect(parseChatOps(p.github.posted[0]!.body)).toEqual({ type: "revise", text: "drop the migration" });
    p.github.label = LABEL.needsInfo;
    expect((await p.post("/api/issues/7/answer", cookie, { text: "Postgres 16" })).status).toBe(200);
    expect(parseChatOps(p.github.posted[1]!.body)).toEqual({ type: "answer", text: "Postgres 16" });
  });

  test("the break-glass token signs as itself, never as a person", async () => {
    const p = make();
    expect((await p.post("/api/issues/7/approve-plan", `Bearer ${TOKEN}`)).status).toBe(200);
    expect(p.github.posted[0]!.body).toBe(
      "/factory approve\n\n<sub>Sent from the factory control plane by the break-glass token</sub>",
    );
  });
});

describe("starting a task", () => {
  test("a task is a signed issue labelled ready, so the runner picks it up", async () => {
    const p = make();
    const res = await p.post("/api/tasks", p.as("operator"), {
      title: " Export invoices as CSV ",
      body: "Finance needs it monthly.",
      type: "feature",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, issue: 41 });
    expect(p.github.created[0]).toEqual({
      title: "Export invoices as CSV",
      body: "Finance needs it monthly.\n\n<sub>Sent from the factory control plane by @operator-person</sub>",
      labels: [LABEL.ready, "feature"],
    });
  });

  test("a missing title, an unknown type or a viewer is refused and nothing is filed", async () => {
    const p = make();
    const cookie = p.as("operator");
    expect((await p.post("/api/tasks", cookie, { title: "" })).status).toBe(400);
    expect((await p.post("/api/tasks", cookie, { title: "x", type: "epic" })).status).toBe(400);
    expect((await p.post("/api/tasks", p.as("viewer"), { title: "x" })).status).toBe(403);
    expect(p.github.created).toHaveLength(0);
  });
});

// The control issue lives in the tracker: the route writes the mode there, and the runner reads it back.
class ModeGitHub extends TrackerGitHub {
  control: GhIssue | undefined;
  override async currentLogin() {
    return "factory-bot";
  }
  override async listIssuesByLabel(_repo: string, label: string) {
    return this.control && label === CONTROL_LABEL ? [this.control] : [];
  }
  override async createIssue(repo: string, title: string, body: string, labels: string[]) {
    const n = await super.createIssue(repo, title, body, labels);
    this.control = { number: n, title, body, labels: labels.map((name) => ({ name })), comments: [] };
    return n;
  }
  override async commentIssue(repo: string, issue: number, body: string) {
    this.control?.comments.push({ id: 1, author: "factory-bot", body, createdAt: "" } as never);
    return super.commentIssue(repo, issue, body);
  }
}

describe("set mode from the web", () => {
  test("an owner sets a repo's autonomy as a signed tracker comment the runner reads back", async () => {
    const github = new ModeGitHub();
    const store = new PlaneStore();
    const access = createAccess({ token: TOKEN, store, env: {} });
    const d = createDashboard(
      new FactoryState(":memory:"),
      github,
      "acme/widgets",
      false,
      "/nonexistent",
      undefined,
      undefined,
      undefined,
      access,
    );
    const session = (role: Role) => {
      store.setMember(`${role}-person`, role, "test");
      const id = crypto.randomUUID();
      store.openSession(id, `${role}-person`, 60_000);
      return `factory_session=${id}`;
    };
    const send = (cookie: string, mode: string) =>
      d.handle(
        new Request(`${BASE}/api/mode`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ mode }),
        }),
        "127.0.0.1",
      );
    expect((await send(session("operator"), "full")).status).toBe(403);
    expect((await send(session("owner"), "reckless")).status).toBe(400);
    expect(github.posted).toHaveLength(0);
    expect((await send(session("owner"), "full")).status).toBe(200);
    expect(github.created[0]!.labels).toEqual([CONTROL_LABEL]);
    expect(github.posted[0]!.body).toContain("Sent from the factory control plane by @owner-person");
    expect(await webMode(github, "acme/widgets")).toBe("full");
    const got = await d.handle(
      new Request(`${BASE}/api/mode`, { headers: { cookie: session("viewer") } }),
      "127.0.0.1",
    );
    expect(await got.json()).toEqual({ mode: "full" });
  });
});
