// SPDX-License-Identifier: LicenseRef-KaaS-EE
// Org mode: one plane serves several teams, each an org that owns some repos. A member acts on a
// repo only with a role in the org that owns it, so a role in one org grants nothing in another.
import type { Route } from "../../dashboard/plane/access";
import type { PlaneContext, PlaneExtension } from "../../dashboard/plane/extension";
import { atLeast, isRole, type Role } from "../../dashboard/plane/store";
import { json } from "./http";

// Routes about the caller, not a repo.
const PLANE_WIDE = new Set(["GET /api/me", "POST /api/logout"]);
// Lists the core narrows to the caller's repos through visibleRepos, so the gate lets them through.
const LISTS = new Set(["GET /api/line"]);
// Where each repo-taking core route reads its repo (dashboard/server.ts); every other route acts on
// the plane's own repo, whatever the request says. ee/tests/org-mode.test.ts pins both sets.
export const QUERY_REPO = new Set([
  "GET /api/issues/:n/thread",
  "GET /api/issues/:n/review",
  "GET /api/issues/:n/live",
  "GET /api/issues/:n/proof",
  "GET /api/inbox",
]);
export const BODY_REPO = new Set(["POST /api/issues/:n/merge", "POST /api/inbox/:n/act"]);
const NAME = /^[a-z][a-z\d-]{1,38}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

// The repo a route acts on, read the way its handler reads it, or a 400 for a request that names
// two repos or a repo that is not a string.
async function targetRepo(req: Request, label: string, defaultRepo: string): Promise<string | Response> {
  const q = new URL(req.url).searchParams.get("repo") || undefined;
  let named: unknown;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const b = (await req
      .clone()
      .json()
      .catch(() => null)) as { repo?: unknown } | null;
    named = b && typeof b === "object" ? b.repo : undefined;
  }
  if (named !== undefined && typeof named !== "string") return json({ error: "repo must be a string" }, 400);
  const body = named || undefined;
  if (q && body && q !== body) return json({ error: "?repo= and the body name different repos" }, 400);
  if (QUERY_REPO.has(label)) return q ?? defaultRepo;
  if (BODY_REPO.has(label)) return body ?? defaultRepo;
  return defaultRepo;
}

export function orgsExtension(defaultRepo: string): PlaneExtension {
  let roleIn: (login: string, repo: string) => Role | null | undefined = () => undefined;
  const routes = (ctx: PlaneContext): Route[] => {
    const db = ctx.store.database;
    db.exec(`CREATE TABLE IF NOT EXISTS ee_org_repos (repo TEXT PRIMARY KEY, org TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ee_org_members (org TEXT NOT NULL, login TEXT NOT NULL, role TEXT NOT NULL,
        PRIMARY KEY (org, login))`);
    // undefined: no org owns the repo; null: an org owns it and the login has no role there.
    roleIn = (login, repo) => {
      const owner = db.query("SELECT org FROM ee_org_repos WHERE repo = ?").get(repo) as { org: string } | null;
      if (!owner) return undefined;
      const m = db.query("SELECT role FROM ee_org_members WHERE org = ? AND login = ?").get(owner.org, login) as {
        role: string;
      } | null;
      return m && isRole(m.role) ? m.role : null;
    };
    const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const by = (req: Request) => ctx.actorOf(req)?.login ?? "~local";
    return [
      {
        method: "GET",
        pattern: /^\/api\/orgs$/,
        label: "GET /api/orgs",
        role: "owner",
        handler: () =>
          json({
            repos: db.query("SELECT org, repo FROM ee_org_repos ORDER BY org, repo").all(),
            members: db.query("SELECT org, login, role FROM ee_org_members ORDER BY org, login").all(),
          }),
      },
      {
        method: "POST",
        pattern: /^\/api\/orgs$/,
        label: "POST /api/orgs",
        role: "owner",
        handler: async (req) => {
          const b = await body(req);
          const repos = b.repos;
          if (typeof b.name !== "string" || !NAME.test(b.name))
            return json({ error: "name must be lowercase, 2 to 39 characters" }, 400);
          if (!Array.isArray(repos) || !repos.every((r) => typeof r === "string" && REPO.test(r)))
            return json({ error: "repos is a list of owner/name" }, 400);
          // A repo belongs to one org; assigning it again moves it.
          for (const r of repos) db.query("INSERT OR REPLACE INTO ee_org_repos VALUES (?, ?)").run(r, b.name);
          return json({ ok: true });
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/orgs\/members$/,
        label: "POST /api/orgs/members",
        role: "owner",
        handler: async (req) => {
          const b = await body(req);
          if (typeof b.org !== "string" || typeof b.login !== "string" || b.login === "")
            return json({ error: "org and login are required" }, 400);
          if (b.role === null) {
            db.query("DELETE FROM ee_org_members WHERE org = ? AND login = ?").run(b.org, b.login);
            return json({ ok: true });
          }
          if (!isRole(b.role)) return json({ error: "role must be viewer, approver, operator, owner or null" }, 400);
          db.query("INSERT OR REPLACE INTO ee_org_members VALUES (?, ?, ?)").run(b.org, b.login, b.role);
          // Signing in needs plane membership; the least role, since the org role does the granting.
          if (ctx.store.storedRole(b.login) === null) ctx.store.assign(b.login, "viewer", by(req));
          return json({ ok: true });
        },
      },
    ];
  };
  return {
    name: "orgs",
    routes,
    allows: async (who, route, req) => {
      const need = route.role ?? "owner";
      // Plane owners run the fleet; owner-only routes stay with the plane ladder.
      if (atLeast(who.role, "owner") || need === "owner" || PLANE_WIDE.has(route.label)) return undefined;
      const unfiltered = route.label === "GET /api/inbox" && !new URL(req.url).searchParams.get("repo");
      if (LISTS.has(route.label) || unfiltered) return undefined;
      const target = await targetRepo(req, route.label, defaultRepo);
      if (target instanceof Response) return target;
      const role = roleIn(who.login, target);
      // A repo no org owns is the fleet's, so only plane owners reach it.
      if (!role) return false;
      return atLeast(role, need);
    },
    visibleRepos: (who, repos) =>
      atLeast(who.role, "owner") ? [...repos] : repos.filter((r) => !!roleIn(who.login, r)),
  };
}
