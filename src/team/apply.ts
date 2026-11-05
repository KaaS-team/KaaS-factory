// Applies the org and team files under <repo>/.factory/team/ to a loaded config. A repo with no
// such directory gets its config back unchanged.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig, RouteConfig } from "../config";
import { resolveOrchestrate } from "../orchestrate/config";
import { approvalPolicyOf } from "./approval";
import { teamCapUsd } from "./budget";
import { egressPolicyOf } from "./egress-policy";
import { loadOrg, loadTeams } from "./load";
import { type Resolved, resolveTeam } from "./resolve";
import { routeTeam, type IssueFacts } from "./route";
import { type PolicySpec, type Risk, RISKS } from "./schema";

export interface TeamApplied {
  config: FactoryConfig;
  resolved: Resolved;
  team?: string;
  // The org's locked list, for `factory config explain`.
  locked: string[];
  problems: string[];
}

export interface ApplyInput {
  repoDir: string;
  config: FactoryConfig;
  defaults: FactoryConfig;
  raw: Record<string, unknown>;
  check: (raw: unknown) => string[];
  // The issue's labels and changed paths. Without them a repo that several teams list is a problem;
  // with them the team that owns a label or a path takes it (src/team/route.ts).
  issue?: IssueFacts;
  // Names the team directly (`factory config explain --team`).
  team?: string;
}

const KEYS = ["workflow", "labels", "routes"] as const;
const view = (c: Record<string, unknown>): Record<string, unknown> => {
  const out = Object.fromEntries(KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
  const merge = c.merge as { autonomy?: unknown } | undefined;
  if (merge?.autonomy !== undefined) out.autonomy = merge.autonomy;
  return out;
};

export function applyTeam(input: ApplyInput): TeamApplied {
  const { config } = input;
  const dir = join(input.repoDir, ".factory", "team");
  const base = { builtin: view(input.defaults as unknown as Record<string, unknown>), repo: view(input.raw) };
  if (!existsSync(dir)) return { config, resolved: resolveTeam(base), locked: [], problems: [] };

  const org = loadOrg(dir);
  const teams = loadTeams(dir);
  if (!org.ok || !teams.ok) {
    return {
      config,
      resolved: resolveTeam(base),
      locked: [],
      problems: [...(org.ok ? [] : org.problems), ...(teams.ok ? [] : teams.problems)],
    };
  }
  const mine = teams.value.filter((t) => (t.repos ?? []).some((r) => r.toLowerCase() === config.repo.toLowerCase()));
  const named = input.team === undefined ? undefined : teams.value.find((t) => t.name === input.team);
  if (input.team !== undefined && !named) {
    return {
      config,
      resolved: resolveTeam(base),
      locked: [],
      problems: [`There is no team named ${input.team} in ${dir}/teams.`],
    };
  }
  const routed = mine.length > 1 && input.issue ? routeTeam(mine, config.repo, input.issue) : undefined;
  // Several teams that each say what they own cannot be told apart without an issue: the repo-level
  // config then applies as if no team matched, and routing happens once the issue is known.
  if (mine.length > 1 && !named && !routed && !input.issue && mine.every((t) => t.owns))
    return { config, resolved: resolveTeam({ ...base, org: org.value }), locked: org.value.locked ?? [], problems: [] };
  if (mine.length > 1 && !named && !routed) {
    return {
      config,
      resolved: resolveTeam(base),
      locked: [],
      problems: [
        `teams ${mine.map((t) => t.name).join(" and ")} all list ${config.repo} in repos; ${
          input.issue
            ? "none owns this issue by label or path and exactly one has no owns to take the rest"
            : "give each an owns label or path so an issue can be routed"
        }.`,
      ],
    };
  }
  const team = named ?? (routed ? mine.find((t) => t.name === routed.team) : mine[0]);
  const resolved = resolveTeam({ ...base, org: org.value, team });
  const p = (resolved.values.policy ?? {}) as PolicySpec;
  const orch = resolveOrchestrate({
    org: org.value.orchestrate,
    team: team?.orchestrate,
    repo: input.raw.orchestrate,
    policyModels: p.models,
    locked: org.value.locked,
    teamName: team?.name,
  });
  for (const [k, v] of Object.entries(orch.origin)) resolved.origin[`orchestrate.${k}`] = v;
  resolved.problems.push(...orch.problems);

  const approval = approvalPolicyOf(p);
  const held =
    p.auto_merge?.allowed === false && config.merge.policy === "auto"
      ? { ...config.merge, policy: "dry-run" as const }
      : config.merge;
  // Below merge-on-green a person approves the plan and the merge: the tier is pulled back to supervised.
  const merge = approval && approval.level !== "merge-on-green" ? { ...held, autonomy: "supervised" as const } : held;
  const rank = (r: string | undefined) => (r === undefined ? RISKS.length : RISKS.indexOf(r as Risk));
  const cap = Math.min(rank(p.risk_max), rank(p.auto_merge?.max_risk));
  const riskPolicy =
    cap < rank(config.riskPolicy.autoApproveMaxRisk)
      ? { ...config.riskPolicy, autoApproveMaxRisk: RISKS[cap] as "low" | "medium" }
      : config.riskPolicy;
  const egress = egressPolicyOf(p);
  const monthlyUsd = teamCapUsd(p.budget_usd_month, team?.budget_usd_month);
  const spend =
    team && monthlyUsd !== undefined
      ? { ...config.spend, team: { name: team.name, monthlyUsd, repos: team.repos ?? [] } }
      : config.spend;
  const next: FactoryConfig = {
    ...config,
    spend,
    ...(egress ? { egress } : {}),
    ...(approval ? { approval } : {}),
    workflow: resolved.values.workflow as string,
    labels: resolved.values.labels as Record<string, string>,
    routes: resolved.values.routes as Record<string, RouteConfig>,
    merge: resolved.values.autonomy ? { ...merge, autonomy: resolved.values.autonomy as typeof merge.autonomy } : merge,
    riskPolicy,
    protectedPaths: [...new Set([...config.protectedPaths, ...(p.protected_paths ?? [])])],
    orchestrate: orch.spec,
  };
  return {
    config: next,
    resolved,
    team: team?.name,
    locked: org.value.locked ?? [],
    problems: input.check({ ...input.raw, workflow: next.workflow, labels: next.labels, routes: next.routes }),
  };
}
