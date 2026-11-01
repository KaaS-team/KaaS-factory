// The two token scopes (#312). Every route declares exactly one; tests/route-scopes.test.ts walks ROUTES.
//   read-act       read runs, spend and metrics and act on them (view the stream).
//   edit-structure change structure: repos, config, labels. No route needs it yet, so no
//                  token can reach one until a route declares it.
// The scopes are independent: holding one never implies the other.

import { ROUTES } from "./api/routes";

export const SCOPES = ["read-act", "edit-structure"] as const;
export type Scope = (typeof SCOPES)[number];

export const ROUTE_SCOPES: Readonly<Record<string, Scope>> = {
  health: "read-act",
  "repos.list": "read-act",
  "runs.list": "read-act",
  "runs.get": "read-act",
  "runs.events": "read-act",
  "spend.get": "read-act",
  "metrics.get": "read-act",
  stream: "read-act",
};

/** The scope a route needs; throws for a route that declares none, so a gap cannot pass silently. */
export function scopeOf(route: { id: string }): Scope {
  const scope = ROUTE_SCOPES[route.id];
  if (!scope) throw new Error(`route ${route.id} declares no scope`);
  return scope;
}

/** Whether a token holding `granted` may call `route`. Unknown scope names grant nothing. */
export function scopeAllows(granted: readonly string[], route: { id: string }): boolean {
  return granted.includes(scopeOf(route));
}

/** Route ids with no declared scope, for the startup check and the structural test. */
export const undeclaredRoutes = (): string[] => ROUTES.filter((r) => !(r.id in ROUTE_SCOPES)).map((r) => r.id);
