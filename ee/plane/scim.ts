// SPDX-License-Identifier: LicenseRef-KaaS-EE
// SCIM 2.0 Users (RFC 7643, 7644): the IdP creates, deactivates and deletes plane members, so
// leaving the company ends plane access. An inactive or deleted user loses membership and sessions.
import { randomUUID } from "node:crypto";
import type { Route } from "../../dashboard/plane/access";
import type { PlaneContext } from "../../dashboard/plane/extension";
import type { Role } from "../../dashboard/plane/store";
import { json, same } from "./http";

export const SCIM_TOKEN_ENV = "FACTORY_SCIM_TOKEN";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const TYPE = "application/scim+json";
// The IdP decides who is in; the plane's least role until an owner raises it.
const DEFAULT_ROLE: Role = "viewer";

interface Row {
  id: string;
  user_name: string;
  external_id: string | null;
  active: number;
}

const scimError = (status: number, detail: string) =>
  json({ schemas: [ERROR], status: String(status), detail }, status, TYPE);

export function scimRoutes(ctx: PlaneContext): Route[] {
  const db = ctx.store.database;
  db.exec(`CREATE TABLE IF NOT EXISTS ee_scim_users (
    id TEXT PRIMARY KEY, user_name TEXT NOT NULL UNIQUE, external_id TEXT, active INTEGER NOT NULL
  )`);
  const get = (id: string) => db.query("SELECT * FROM ee_scim_users WHERE id = ?").get(id) as Row | null;
  const view = (r: Row) => ({
    schemas: [USER],
    id: r.id,
    userName: r.user_name,
    externalId: r.external_id ?? undefined,
    active: r.active === 1,
    emails: [{ value: r.user_name, primary: true }],
    meta: { resourceType: "User", location: `/scim/v2/Users/${r.id}` },
  });
  // Membership follows `active`: on keeps the role an owner gave (viewer when none), off removes
  // the member and their sessions. Roles stay with owners, so the IdP cannot raise anyone to owner.
  const apply = (r: Row) =>
    ctx.store.assign(r.user_name, r.active === 1 ? (ctx.store.storedRole(r.user_name) ?? DEFAULT_ROLE) : null, "~scim");
  const audit = (route: string, status: number) =>
    ctx.store.record({ actor: "~scim", role: "scim", route, issue: null, status });

  const authed = (req: Request) => {
    const token = ctx.env[SCIM_TOKEN_ENV] ?? "";
    const header = req.headers.get("authorization") ?? "";
    return token !== "" && header.startsWith("Bearer ") && same(header.slice(7), token);
  };
  const guard =
    (label: string, run: (req: Request, m: RegExpMatchArray) => Promise<Response> | Response) =>
    async (req: Request, _u: URL, m: RegExpMatchArray) => {
      if (!authed(req)) return scimError(401, "a valid SCIM bearer token is required");
      const res = await run(req, m);
      if (req.method !== "GET") audit(label, res.status);
      return res;
    };
  const body = async (req: Request) => (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const route = (method: Route["method"], path: string, run: Parameters<typeof guard>[1]): Route => {
    const label = `${method} /scim/v2/Users${path ? "/:id" : ""}`;
    const pattern = new RegExp(`^/scim/v2/Users${path ? "/([\\w-]+)" : ""}$`);
    return { method, pattern, label, public: true, handler: guard(label, run) };
  };

  return [
    route("GET", "", (req) => {
      const url = new URL(req.url);
      const filter = url.searchParams.get("filter");
      // The one filter IdPs send before a create: userName eq "x".
      const eq = filter ? /^userName eq "([^"]*)"$/i.exec(filter) : null;
      if (filter && !eq) return scimError(400, 'only the filter userName eq "<value>" is supported');
      const rows = (
        eq
          ? db.query("SELECT * FROM ee_scim_users WHERE user_name = ?").all(eq[1]!.toLowerCase())
          : db.query("SELECT * FROM ee_scim_users ORDER BY user_name LIMIT 500").all()
      ) as Row[];
      return json(
        {
          schemas: [LIST],
          totalResults: rows.length,
          itemsPerPage: rows.length,
          startIndex: 1,
          Resources: rows.map(view),
        },
        200,
        TYPE,
      );
    }),
    route("GET", ":id", (_req, m) => {
      const r = get(m[1]!);
      return r ? json(view(r), 200, TYPE) : scimError(404, "no such user");
    }),
    route("POST", "", async (req) => {
      const b = await body(req);
      const userName = typeof b?.userName === "string" ? b.userName.trim().toLowerCase() : "";
      // An email can never be a GitHub login, so an IdP user cannot take over a GitHub member's row.
      if (!/^[^@\s]+@[^@\s]+$/.test(userName)) return scimError(400, "userName must be an email address");
      if (db.query("SELECT 1 FROM ee_scim_users WHERE user_name = ?").get(userName))
        return json(
          { schemas: [ERROR], status: "409", scimType: "uniqueness", detail: "userName is taken" },
          409,
          TYPE,
        );
      const r: Row = {
        id: randomUUID(),
        user_name: userName,
        external_id: typeof b?.externalId === "string" ? b.externalId : null,
        active: b?.active === false ? 0 : 1,
      };
      db.query("INSERT INTO ee_scim_users VALUES (?, ?, ?, ?)").run(r.id, r.user_name, r.external_id, r.active);
      apply(r);
      return json(view(r), 201, TYPE);
    }),
    route("PATCH", ":id", async (req, m) => {
      const r = get(m[1]!);
      if (!r) return scimError(404, "no such user");
      const b = await body(req);
      if (!Array.isArray(b?.schemas) || !b.schemas.includes(PATCH)) return scimError(400, "expected a PatchOp");
      for (const op of (b.Operations ?? []) as { op?: string; path?: string; value?: unknown }[]) {
        if (String(op.op).toLowerCase() !== "replace") return scimError(400, `op ${op.op} is not supported`);
        const value = op.path ? { [op.path]: op.value } : (op.value as Record<string, unknown>);
        if (typeof value?.active === "boolean") r.active = value.active ? 1 : 0;
      }
      db.query("UPDATE ee_scim_users SET active = ? WHERE id = ?").run(r.active, r.id);
      apply(r);
      return json(view(r), 200, TYPE);
    }),
    route("DELETE", ":id", (_req, m) => {
      const r = get(m[1]!);
      if (!r) return scimError(404, "no such user");
      db.query("DELETE FROM ee_scim_users WHERE id = ?").run(r.id);
      ctx.store.assign(r.user_name, null, "~scim");
      return new Response(null, { status: 204 });
    }),
  ];
}
