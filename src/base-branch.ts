import type { FactoryConfig } from "./config";

// The base branch an issue of this route branches from: config.baseByRoute[route], else config.base.
export function resolveBase(route: string | undefined, config: Pick<FactoryConfig, "base" | "baseByRoute">): string {
  if (route !== undefined && config.baseByRoute && Object.hasOwn(config.baseByRoute, route))
    return config.baseByRoute[route] as string;
  return config.base;
}

export function baseByRouteProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["baseByRoute: expected an object"];
  return Object.entries(raw)
    .filter(([, branch]) => typeof branch !== "string" || branch.length === 0)
    .map(([route, branch]) => `baseByRoute.${route}: expected a non-empty branch name, got ${JSON.stringify(branch)}`);
}
