// Who is calling, what role they hold, and the routes that sign them in. The
// token stays as break-glass; people sign in with GitHub and an owner grants
// them a role (docs/control-plane.md).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { atLeast, isRole, PlaneStore, type Role } from "./store";

export type Handler = (req: Request, url: URL, m: RegExpMatchArray) => Response | Promise<Response>;
export interface Route {
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  readonly label: string;
  // Missing means owner: a route nobody classified fails closed.
  readonly role?: Role;
  readonly handler: Handler;
}

export interface Actor {
  login: string;
  role: Role;
}

// Not valid GitHub logins, so no account can collide with them.
export const BREAK_GLASS = "~break-glass";
export const LOCAL = "~local";
// The relay publisher reads the inbox in-process; it may read, never write.
const IN_PROCESS: Actor = { login: "~relay", role: "viewer" };

const SESSION_COOKIE = "factory_session";
const STATE_COOKIE = "factory_oauth_state";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const OAUTH_TIMEOUT_MS = 10_000;
export const CLIENT_ID_ENV = "FACTORY_GITHUB_CLIENT_ID";
export const CLIENT_SECRET_ENV = "FACTORY_GITHUB_CLIENT_SECRET";

// Compare digests so the check takes the same time wherever the strings differ.
export function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function cookie(req: Request, name: string): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

// Behind a TLS-terminating proxy the request arrives as http, so X-Forwarded-Proto counts too.
const isHttps = (req: Request) =>
  new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

function setCookie(req: Request, name: string, value: string, maxAge: number, sameSite = "Strict"): string {
  const secure = isHttps(req) ? "; Secure" : "";
  return `${name}=${value}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${secure}`;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

export interface AccessOptions {
  token: string;
  store?: PlaneStore;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export function createAccess(opts: AccessOptions) {
  const store = opts.store ?? new PlaneStore();
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? fetch;
  const clientId = () => env[CLIENT_ID_ENV] ?? "";
  const clientSecret = () => env[CLIENT_SECRET_ENV] ?? "";
  const github = () => clientId() !== "" && clientSecret() !== "";
  // The plane may face a network only when something guards it.
  const guarded = () => opts.token !== "" || github();

  function actor(req: Request, loopback: boolean): Actor | null {
    const header = req.headers.get("authorization") ?? "";
    if (header.startsWith("Bearer "))
      return opts.token && tokenMatches(header.slice(7), opts.token) ? { login: BREAK_GLASS, role: "owner" } : null;
    const login = store.sessionLogin(cookie(req, SESSION_COOKIE));
    if (login === BREAK_GLASS) return { login, role: "owner" };
    // The role is read on every request, so removing a member ends their access at once.
    const role = login ? store.roleOf(login) : null;
    if (login && role) return { login, role };
    return !guarded() && loopback ? { login: LOCAL, role: "owner" } : null;
  }

  function startSession(req: Request, login: string, extra: Record<string, string> = {}, status = 200): Response {
    // The cookie is a random id, never the token, so a leaked cookie cannot be replayed as a Bearer token.
    const id = randomBytes(32).toString("hex");
    store.openSession(id, login, SESSION_TTL_MS);
    const headers = new Headers(extra);
    headers.append("set-cookie", setCookie(req, SESSION_COOKIE, id, SESSION_TTL_MS / 1000));
    if (status === 302) {
      headers.append("set-cookie", setCookie(req, STATE_COOKIE, "", 0, "Lax"));
      return new Response(null, { status, headers });
    }
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify({ ok: true }), { status, headers });
  }

  const origin = (req: Request) => `${isHttps(req) ? "https" : "http"}://${new URL(req.url).host}`;

  async function githubLogin(req: Request, code: string): Promise<{ login: string; id: number; name: string | null }> {
    const signal = AbortSignal.timeout(OAUTH_TIMEOUT_MS);
    const tokenRes = await doFetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      signal,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId(),
        client_secret: clientSecret(),
        code,
        redirect_uri: `${origin(req)}/auth/github/callback`,
      }),
    });
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) throw new Error("GitHub refused the sign-in code");
    // The GitHub token is used once for the login and then dropped; the plane never acts as the user.
    const userRes = await doFetch("https://api.github.com/user", {
      signal,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${access_token}` },
    });
    const user = (await userRes.json()) as { login?: string; id?: number; name?: string | null };
    if (!userRes.ok || typeof user.login !== "string") throw new Error("GitHub did not return a user");
    return { login: user.login, id: user.id ?? 0, name: user.name ?? null };
  }

  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/api\/session$/,
      label: "POST /api/session",
      // Trade the break-glass token for an HttpOnly cookie so a browser never puts it in a URL.
      handler: async (req) => {
        const body = (await req.json().catch(() => ({}))) as { token?: string };
        if (!opts.token || typeof body.token !== "string" || !tokenMatches(body.token, opts.token))
          return json({ error: "unauthorized" }, 401);
        return startSession(req, BREAK_GLASS);
      },
    },
    {
      method: "GET",
      pattern: /^\/auth\/github$/,
      label: "GET /auth/github",
      handler: (req) => {
        if (!github()) return json({ error: "GitHub sign-in is not set up on this factory" }, 404);
        const state = randomBytes(16).toString("hex");
        const to = new URL("https://github.com/login/oauth/authorize");
        to.searchParams.set("client_id", clientId());
        to.searchParams.set("redirect_uri", `${origin(req)}/auth/github/callback`);
        to.searchParams.set("scope", "read:user");
        to.searchParams.set("state", state);
        // Lax, because GitHub sends the browser back here from another site.
        return new Response(null, {
          status: 302,
          headers: { location: to.toString(), "set-cookie": setCookie(req, STATE_COOKIE, state, 600, "Lax") },
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/auth\/github\/callback$/,
      label: "GET /auth/github/callback",
      handler: async (req, url) => {
        if (!github()) return json({ error: "GitHub sign-in is not set up on this factory" }, 404);
        const expected = cookie(req, STATE_COOKIE);
        const state = url.searchParams.get("state") ?? "";
        if (!expected || !tokenMatches(state, expected)) return json({ error: "sign-in expired, start again" }, 400);
        let user: Awaited<ReturnType<typeof githubLogin>>;
        try {
          user = await githubLogin(req, url.searchParams.get("code") ?? "");
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
        store.seen(user.login, user.id, user.name);
        const role = store.roleOf(user.login);
        store.record({
          actor: user.login,
          role: role ?? "none",
          route: "sign-in",
          issue: null,
          status: role ? 302 : 403,
        });
        if (!role)
          return json({ error: `${user.login} is not a member of this factory; ask an owner to add you` }, 403);
        return startSession(req, user.login, { location: "/" }, 302);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/logout$/,
      label: "POST /api/logout",
      role: "viewer",
      handler: (req) => {
        store.closeSession(cookie(req, SESSION_COOKIE));
        return json({ ok: true }, 200, { "set-cookie": setCookie(req, SESSION_COOKIE, "", 0) });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/me$/,
      label: "GET /api/me",
      role: "viewer",
      handler: (req) => {
        return json({ ...actorOf(req), github: github() });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/members$/,
      label: "GET /api/members",
      role: "owner",
      handler: () => json({ members: store.members() }),
    },
    {
      method: "POST",
      pattern: /^\/api\/members$/,
      label: "POST /api/members",
      role: "owner",
      handler: async (req) => {
        const body = (await req.json().catch(() => ({}))) as { login?: unknown; role?: unknown };
        if (typeof body.login !== "string" || !/^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/.test(body.login))
          return json({ error: "login must be a GitHub login" }, 400);
        if (body.role !== null && !isRole(body.role))
          return json({ error: "role must be viewer, approver, operator, owner or null" }, 400);
        store.setMember(body.login, body.role, actorOf(req)?.login ?? LOCAL);
        return json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/audit$/,
      label: "GET /api/audit",
      role: "owner",
      handler: (_req, url) => {
        const before = Number(url.searchParams.get("before"));
        return json({ rows: store.audit(Number.isInteger(before) && before > 0 ? before : undefined) });
      },
    },
  ];

  // handle() resolves the caller once; handlers read it back here.
  const seenActors = new WeakMap<Request, Actor>();
  const actorOf = (req: Request) => seenActors.get(req);

  // Returns a refusal, or null when the caller may run the route.
  function gate(req: Request, route: Route | undefined, isPublic: boolean, loopback: boolean, inProcess = false) {
    if (isPublic) return null;
    const who = inProcess ? IN_PROCESS : actor(req, loopback);
    if (!who) return json({ error: "unauthorized" }, 401);
    seenActors.set(req, who);
    const need = route?.role ?? "owner";
    if (atLeast(who.role, need)) return null;
    if (req.method === "POST" && route)
      store.record({ actor: who.login, role: who.role, route: route.label, issue: null, status: 403 });
    return json({ error: `needs the ${need} role` }, 403);
  }

  // Every write a person could make is kept with who made it and how it ended.
  async function audited(req: Request, route: Route | undefined, run: () => Promise<Response>): Promise<Response> {
    const who = actorOf(req);
    if (req.method !== "POST" || !who || !route) return run();
    const fromPath = new URL(req.url).pathname.match(/\/(\d+)(?:\/|$)/)?.[1];
    const fromBody = fromPath
      ? undefined
      : (
          (await req
            .clone()
            .json()
            .catch(() => ({}))) as { issue?: unknown }
        ).issue;
    const issue = Number(fromPath ?? fromBody);
    let status = 500;
    try {
      const res = await run();
      status = res.status;
      return res;
    } finally {
      store.record({
        actor: who.login,
        role: who.role,
        route: route.label,
        issue: Number.isInteger(issue) ? issue : null,
        status,
      });
    }
  }

  return { routes, guarded, gate, audited, actorOf, store };
}
