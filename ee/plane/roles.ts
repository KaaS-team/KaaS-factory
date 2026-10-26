// SPDX-License-Identifier: LicenseRef-KaaS-EE
// Custom roles: a named role starts from a ladder rank, then grants or denies single routes, e.g.
// "release-manager" is a viewer who may also merge. A grant never reaches an owner-only route.
import type { Route } from "../../dashboard/plane/access";
import type { PlaneContext, PlaneExtension } from "../../dashboard/plane/extension";
import { isRole, type Role } from "../../dashboard/plane/store";
import { json } from "./http";

export interface CustomRole {
  readonly name: string;
  readonly base: Role;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

const NAME = /^[a-z][a-z\d-]{1,30}$/;

export function rolesExtension(): PlaneExtension {
  let get: (name: string) => CustomRole | null = () => null;
  const routes = (ctx: PlaneContext): Route[] => {
    const db = ctx.store.database;
    db.exec(
      "CREATE TABLE IF NOT EXISTS ee_roles (name TEXT PRIMARY KEY, base TEXT NOT NULL, allow TEXT NOT NULL, deny TEXT NOT NULL)",
    );
    get = (name) => {
      const r = db.query("SELECT * FROM ee_roles WHERE name = ?").get(name) as Record<string, string> | null;
      return r && isRole(r.base)
        ? { name: r.name!, base: r.base, allow: JSON.parse(r.allow!), deny: JSON.parse(r.deny!) }
        : null;
    };
    const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const labels = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string" && /^[A-Z]+ \//.test(x));
    return [
      {
        method: "GET",
        pattern: /^\/api\/roles$/,
        label: "GET /api/roles",
        role: "owner",
        handler: () =>
          json({
            roles: (db.query("SELECT name FROM ee_roles ORDER BY name").all() as { name: string }[]).map((r) =>
              get(r.name),
            ),
          }),
      },
      {
        method: "POST",
        pattern: /^\/api\/roles$/,
        label: "POST /api/roles",
        role: "owner",
        handler: async (req) => {
          const b = await body(req);
          if (typeof b.name !== "string" || !NAME.test(b.name) || isRole(b.name))
            return json({ error: "name must be lowercase, 2 to 31 characters, and not a built-in role" }, 400);
          if (!isRole(b.base)) return json({ error: "base must be viewer, approver, operator or owner" }, 400);
          const allow = b.allow ?? [];
          const deny = b.deny ?? [];
          if (!labels(allow) || !labels(deny))
            return json({ error: 'allow and deny are route labels like "POST /api/tasks"' }, 400);
          db.query(
            `INSERT INTO ee_roles VALUES (?, ?, ?, ?)
             ON CONFLICT (name) DO UPDATE SET base = excluded.base, allow = excluded.allow, deny = excluded.deny`,
          ).run(b.name, b.base, JSON.stringify(allow), JSON.stringify(deny));
          return json({ ok: true });
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/roles\/assign$/,
        label: "POST /api/roles/assign",
        role: "owner",
        handler: async (req) => {
          const b = await body(req);
          if (typeof b.login !== "string" || b.login === "") return json({ error: "login is required" }, 400);
          if (typeof b.role !== "string" || !get(b.role)) return json({ error: "role must name a custom role" }, 400);
          ctx.store.assign(b.login, b.role, ctx.actorOf(req)?.login ?? "~local");
          return json({ ok: true });
        },
      },
    ];
  };
  return {
    name: "roles",
    routes,
    actor: (login, stored) => {
      const role = get(stored);
      return role ? { login, role: role.base, custom: role.name } : null;
    },
    // Read on every request, so editing or deleting a role applies at once.
    allows: (who, route) => {
      if (!who.custom) return undefined;
      const role = get(who.custom);
      if (!role || role.deny.includes(route.label)) return false;
      const need = route.role ?? "owner";
      return role.allow.includes(route.label) && need !== "owner" ? true : undefined;
    },
  };
}
