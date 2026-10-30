// Applies the org and team files under <repo>/.factory/team/ to a loaded config. A repo with no
// such directory gets its config back unchanged.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig, RouteConfig } from "../config";
import { loadOrg, loadTeams } from "./load";
import { type Resolved, resolveTeam } from "./resolve";
import { type PolicySpec, type Risk, RISKS } from "./schema";

export interface TeamApplied {
  config: FactoryConfig;
  resolved: Resolved;
  team?: string;
  problems: string[];
}

export interface ApplyInput {
  repoDir: string;
  config: FactoryConfig;
  defaults: FactoryConfig;
  raw: Record<string, unknown>;
  check: (raw: unknown) => string[];
}

const KEYS = ["workflow", "labels", "routes"] as const;
const view = (c: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));

export function applyTeam(input: ApplyInput): TeamApplied {
  const { config } = input;
  const dir = join(input.repoDir, ".factory", "team");
  const base = { builtin: view(input.defaults as unknown as Record<string, unknown>), repo: view(input.raw) };
  if (!existsSync(dir)) return { config, resolved: resolveTeam(base), problems: [] };

  const org = loadOrg(dir);
  const teams = loadTeams(dir);
  if (!org.ok || !teams.ok) {
    return {
      config,
      resolved: resolveTeam(base),
      problems: [...(org.ok ? [] : org.problems), ...(teams.ok ? [] : teams.problems)],
    };
  }
  const mine = teams.value.filter((t) => (t.repos ?? []).some((r) => r.toLowerCase() === config.repo.toLowerCase()));
  if (mine.length > 1) {
    return {
      config,
      resolved: resolveTeam(base),
      problems: [
        `teams ${mine.map((t) => t.name).join(" and ")} both list ${config.repo} in repos; a repo belongs to one team.`,
      ],
    };
  }
  const team = mine[0];
  const resolved = resolveTeam({ ...base, org: org.value, team });
  const p = (resolved.values.policy ?? {}) as PolicySpec;

  const merge =
    p.auto_merge?.allowed === false && config.merge.policy === "auto"
      ? { ...config.merge, policy: "dry-run" as const }
      : config.merge;
  const rank = (r: string | undefined) => (r === undefined ? RISKS.length : RISKS.indexOf(r as Risk));
  const cap = Math.min(rank(p.risk_max), rank(p.auto_merge?.max_risk));
  const riskPolicy =
    cap < rank(config.riskPolicy.autoApproveMaxRisk)
      ? { ...config.riskPolicy, autoApproveMaxRisk: RISKS[cap] as "low" | "medium" }
      : config.riskPolicy;
  const next: FactoryConfig = {
    ...config,
    workflow: resolved.values.workflow as string,
    labels: resolved.values.labels as Record<string, string>,
    routes: resolved.values.routes as Record<string, RouteConfig>,
    merge,
    riskPolicy,
    protectedPaths: [...new Set([...config.protectedPaths, ...(p.protected_paths ?? [])])],
  };
  return {
    config: next,
    resolved,
    team: team?.name,
    problems: input.check({ ...input.raw, workflow: next.workflow, labels: next.labels, routes: next.routes }),
  };
}
