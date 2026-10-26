// Structural: every dashboard route names the least role that may call it, a
// signed-in person reaches exactly the routes their role allows, and every
// write leaves an audit row. GitHub sign-in runs against a fake GitHub.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboard, PUBLIC_ROUTES } from "../dashboard/server";
import { createAccess } from "../dashboard/plane/access";
import { atLeast, PlaneStore, ROLES, type Role } from "../dashboard/plane/store";
import { GitHub } from "../src/github";
import { FactoryState } from "../src/state";

const TOKEN = "break-glass-token";
const scratch = mkdtempSync(join(tmpdir(), "factory-plane-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

class QuietGitHub extends GitHub {
  override async listOpenIssues() {
    return [];
  }
  override async listPrs() {
    return [];
  }
  override async commentIssue() {
    return 1;
  }
  override async addLabels() {}
}

// GitHub's two OAuth calls: the code is the login, so a test signs in as anyone.
const fakeGitHub = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url === "https://github.com/login/oauth/access_token") {
    const { code } = JSON.parse(String(init?.body)) as { code: string };
    return Response.json(code === "refused" ? { error: "bad_verification_code" } : { access_token: `gho_${code}` });
  }
  if (url === "https://api.github.com/user") {
    const login = new Headers(init?.headers).get("authorization")!.replace("Bearer gho_", "");
    return Response.json({ login, id: 7, name: null });
  }
  return new Response("unexpected", { status: 500 });
}) as typeof fetch;

function make(opts: { token?: string; github?: boolean } = {}) {
  const dbPath = join(scratch, `${crypto.randomUUID()}.db`);
  const store = new PlaneStore(dbPath);
  const env = opts.github === false ? {} : { FACTORY_GITHUB_CLIENT_ID: "id", FACTORY_GITHUB_CLIENT_SECRET: "secret" };
  const access = createAccess({ token: opts.token ?? TOKEN, store, env, fetch: fakeGitHub });
  const state = new FactoryState(":memory:");
  const dashboard = createDashboard(
    state,
    new QuietGitHub(),
    "acme/widgets",
    false,
    "/nonexistent",
    undefined,
    undefined,
    undefined,
    access,
  );
  return { dashboard, store, dbPath };
}

const BASE = "http://localhost:4100";
const samplePath = (label: string) => label.split(" ")[1]!.replace(":n", "1").replace(":id", "1");

function request(label: string, headers: Record<string, string> = {}, body = "{}") {
  const [method] = label.split(" ");
  return new Request(`${BASE}${samplePath(label)}`, {
    method,
    headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), ...headers },
    body: method === "POST" ? body : undefined,
  });
}

const setCookies = (res: Response) =>
  Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0]!.split("=") as [string, string]));

type Plane = ReturnType<typeof make>;

async function signIn(p: Plane, login: string, state?: string): Promise<{ res: Response; cookie: string }> {
  const start = await p.dashboard.handle(new Request(`${BASE}/auth/github`), "127.0.0.1");
  expect(start.status).toBe(302);
  const issued = setCookies(start).factory_oauth_state!;
  expect(new URL(start.headers.get("location")!).searchParams.get("state")).toBe(issued);
  const res = await p.dashboard.handle(
    new Request(`${BASE}/auth/github/callback?code=${login}&state=${state ?? issued}`, {
      headers: { cookie: `factory_oauth_state=${issued}` },
    }),
    "127.0.0.1",
  );
  const id = setCookies(res).factory_session;
  return { res, cookie: id ? `factory_session=${id}` : "" };
}

async function asRole(p: Plane, role: Role): Promise<string> {
  p.store.setMember(`${role}-person`, role, "test");
  return (await signIn(p, `${role}-person`)).cookie;
}

async function status(p: Plane, req: Request, address = "127.0.0.1"): Promise<number> {
  try {
    return (await p.dashboard.handle(req, address)).status;
  } catch {
    return 500; // a handler that throws on an empty body was still let through
  }
}

const roleOf = (p: Plane, label: string) => p.dashboard.routeRoles[label] as Role | undefined;
const guardedRoutes = (p: Plane) => p.dashboard.routeLabels.filter((l) => !PUBLIC_ROUTES.includes(l));

describe("roles", () => {
  test("every route that is not public names a role, and no public route has one", () => {
    const p = make();
    for (const label of p.dashboard.routeLabels) {
      if (PUBLIC_ROUTES.includes(label)) expect(roleOf(p, label), label).toBeUndefined();
      else expect(ROLES, label).toContain(roleOf(p, label)!);
    }
  });

  test("a write needs more than viewer, and settings and members need owner", () => {
    const p = make();
    for (const label of guardedRoutes(p).filter((l) => l.startsWith("POST ") && l !== "POST /api/logout"))
      expect(atLeast(roleOf(p, label)!, "approver"), label).toBe(true);
    for (const label of ["POST /api/toggles", "POST /api/members", "GET /api/members", "GET /api/audit"])
      expect(roleOf(p, label), label).toBe("owner");
  });

  test("each role reaches exactly the routes its rank allows", async () => {
    const p = make();
    for (const label of guardedRoutes(p)) {
      expect(await status(p, request(label)), `anonymous ${label}`).toBe(401);
      for (const role of ROLES) {
        const got = await status(p, request(label, { cookie: await asRole(p, role) }));
        const allowed = atLeast(role, roleOf(p, label)!);
        if (allowed) expect([401, 403], `${role} ${label}`).not.toContain(got);
        else expect(got, `${role} ${label}`).toBe(403);
      }
    }
  });
});

describe("audit", () => {
  test("every write a member makes leaves a row with who, what and how it ended", async () => {
    const p = make();
    const cookie = await asRole(p, "owner");
    // Logout ends the session, so it goes last.
    const writes = guardedRoutes(p).filter((l) => l.startsWith("POST "));
    writes.sort((a, b) => Number(a === "POST /api/logout") - Number(b === "POST /api/logout"));
    expect(writes.length).toBeGreaterThan(6);
    for (const label of writes) {
      const before = p.store.audit().length;
      const got = await status(p, request(label, { cookie }, JSON.stringify({ issue: 4 })));
      const row = p.store.audit()[0]!;
      expect(p.store.audit().length, label).toBe(before + 1);
      expect(row, label).toMatchObject({ actor: "owner-person", role: "owner", route: label, status: got });
      expect(row.issue, label).toBe(label.includes(":n") ? 1 : 4);
    }
  });

  test("a refused write is kept too, and a read is not", async () => {
    const p = make();
    const cookie = await asRole(p, "viewer");
    expect(await status(p, request("POST /api/toggles", { cookie }))).toBe(403);
    expect(p.store.audit()[0]).toMatchObject({ actor: "viewer-person", route: "POST /api/toggles", status: 403 });
    const before = p.store.audit().length;
    expect(await status(p, request("GET /api/runs", { cookie }))).toBe(200);
    expect(p.store.audit().length).toBe(before);
  });
});

describe("GitHub sign-in", () => {
  test("a member signs in and /api/me names their role", async () => {
    const p = make();
    const cookie = await asRole(p, "approver");
    const me = await p.dashboard.handle(request("GET /api/me", { cookie }), "127.0.0.1");
    expect(await me.json()).toMatchObject({ login: "approver-person", role: "approver", github: true });
  });

  test("a state that does not match the cookie is refused before GitHub is asked", async () => {
    const p = make();
    p.store.setMember("mallory", "owner", "test");
    const { res, cookie } = await signIn(p, "mallory", "forged");
    expect(res.status).toBe(400);
    expect(cookie).toBe("");
  });

  test("someone GitHub knows but this factory does not gets no session", async () => {
    const p = make();
    const { res, cookie } = await signIn(p, "stranger");
    expect(res.status).toBe(403);
    expect(cookie).toBe("");
    expect(p.store.audit()[0]).toMatchObject({ actor: "stranger", route: "sign-in", status: 403 });
  });

  test("removing a member ends their session on the next request", async () => {
    const p = make();
    const cookie = await asRole(p, "operator");
    expect(await status(p, request("GET /api/runs", { cookie }))).toBe(200);
    p.store.setMember("operator-person", null, "test");
    expect(await status(p, request("GET /api/runs", { cookie }))).toBe(401);
  });

  test("the role is read on every request, so a demotion or a deleted membership applies at once", async () => {
    const p = make();
    const cookie = await asRole(p, "operator");
    expect(await status(p, request("POST /api/mark-ready", { cookie }))).not.toBe(403);
    p.store.setMember("operator-person", "viewer", "test");
    expect(await status(p, request("POST /api/mark-ready", { cookie }))).toBe(403);
    new Database(p.dbPath).query("DELETE FROM plane_memberships WHERE login = 'operator-person'").run();
    expect(await status(p, request("GET /api/runs", { cookie }))).toBe(401);
  });

  test("an owner adds a member, and a bad login or role is refused", async () => {
    const p = make();
    const cookie = await asRole(p, "owner");
    const add = (body: unknown) => status(p, request("POST /api/members", { cookie }, JSON.stringify(body)));
    expect(await add({ login: "qa-lead", role: "viewer" })).toBe(200);
    expect(p.store.roleOf("qa-lead")).toBe("viewer");
    expect(await add({ login: "qa-lead", role: "root" })).toBe(400);
    expect(await add({ login: "-bad-", role: "viewer" })).toBe(400);
    expect(await add({ login: "qa-lead", role: null })).toBe(200);
    expect(p.store.roleOf("qa-lead")).toBeNull();
  });

  test("the database keeps a digest of each session id, never the id", async () => {
    const p = make();
    const cookie = await asRole(p, "viewer");
    const id = cookie.split("=")[1]!;
    const rows = new Database(p.dbPath).query("SELECT id_hash FROM plane_sessions").all() as { id_hash: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.id_hash).not.toBe(id);
    expect(rows[0]!.id_hash).toHaveLength(64);
  });

  test("sign-in is off when no GitHub app is set up", async () => {
    const p = make({ github: false });
    expect((await p.dashboard.handle(new Request(`${BASE}/auth/github`), "127.0.0.1")).status).toBe(404);
  });
});

describe("break-glass and local use", () => {
  test("the token is an owner, as a Bearer header or traded for a cookie", async () => {
    const p = make();
    expect(await status(p, request("GET /api/members", { authorization: `Bearer ${TOKEN}` }))).toBe(200);
    expect(await status(p, request("GET /api/members", { authorization: "Bearer wrong" }))).toBe(401);
    const res = await p.dashboard.handle(
      request("POST /api/session", {}, JSON.stringify({ token: TOKEN })),
      "127.0.0.1",
    );
    const cookie = `factory_session=${setCookies(res).factory_session}`;
    expect(await status(p, request("GET /api/members", { cookie }))).toBe(200);
  });

  test("the in-process relay reader may read the inbox with a token set, and never write", async () => {
    const p = make();
    expect((await p.dashboard.readInProcess(request("GET /api/inbox"))).status).toBe(200);
    expect((await p.dashboard.readInProcess(request("POST /api/toggles"))).status).toBe(403);
    expect(await status(p, request("GET /api/inbox"))).toBe(401);
  });

  test("with nothing set, loopback is the local owner and anything else is refused", async () => {
    const p = make({ token: "", github: false });
    expect(await status(p, request("GET /api/members"))).toBe(200);
    expect(await status(p, request("GET /api/runs"), "10.0.0.5")).toBe(503);
  });

  test("GitHub sign-in alone guards the plane, so it may face a network", async () => {
    const p = make({ token: "" });
    expect(await status(p, request("GET /api/runs"), "10.0.0.5")).toBe(401);
    expect(await status(p, request("GET /api/runs"))).toBe(401);
  });
});
