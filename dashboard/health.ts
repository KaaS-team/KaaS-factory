// What a load balancer, Coolify or a probe asks: is this the factory, and which build. Public, so it
// carries nothing an operator would hide; the version lets a probe tell a stale deploy from a fresh one.
import pkg from "../package.json" with { type: "json" };
import type { Route } from "./plane/access";

export const HEALTH_ROUTE = "GET /health";

export const healthRoute: Route = {
  method: "GET",
  pattern: /^\/health$/,
  label: HEALTH_ROUTE,
  handler: () => Response.json({ ok: true, service: "kaas-factory", version: pkg.version }),
};
