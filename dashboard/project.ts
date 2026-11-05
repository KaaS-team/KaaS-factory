// The Workflows and Settings pages: what `factory harness inventory` and
// `validate` say about the repo's workflows, and the runtimes and issue leases
// this machine and remote hold. Read-only, built from the same functions the
// CLI uses, so the page and the terminal cannot disagree.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GitLeases } from "../src/adapters/git-lease/lease";
import { agentCatalog } from "../src/agents/docs";
import { configProblems, type FactoryConfig, loadConfig, mergeConfig } from "../src/config";
import { plain } from "../src/display";
import type { HarnessReport } from "../src/harness";
import { agentChecks } from "../src/doctor";
import type { versionOf, which } from "../src/probes";
import { loadMachineConfig } from "../src/machine";
import { configMirrorDir } from "../src/paths";
import { cloneDirFor } from "../src/repo";
import type { Health } from "../src/runtime-kit";
import { builtinRuntimes, DEFAULT_RUNTIME, type RuntimeSpec, runtimeRefs, runtimeSpecs } from "../src/runtimes";
import { fleetView, healthCache } from "./fleet";

import type { DashboardProject } from "../src/dashboard-host";

export type { DashboardProject };

export const READ_ONLY = "read only for this repo: this plane has no clone of it";

// A shipped config.json is checked like a clone's, but the skill and origin checks need a clone.
function mirroredConfig(dir: string, repo: string): FactoryConfig | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, ".factory", "config.json"), "utf8"));
    const config = configProblems(raw).length ? undefined : mergeConfig(raw as Partial<FactoryConfig>);
    return config?.repo === repo ? config : undefined;
  } catch {
    return undefined;
  }
}

// The one way a route finds a repo's project: the primary's own, then the plane's clone of the repo,
// then the copy its runner shipped. A config naming another repo is refused, so B never shows A's.
export function projectResolver(primary: string, project?: DashboardProject, env = process.env) {
  return async (repo: string): Promise<DashboardProject | undefined> => {
    if (repo === primary) return project;
    const base = { machine: project?.machine ?? loadMachineConfig(env), fleet: project?.fleet, git: project?.git };
    const clone = cloneDirFor(repo, env);
    const config = existsSync(join(clone, ".factory", "config.json"))
      ? await loadConfig(clone).catch(() => undefined)
      : undefined;
    if (config?.repo === repo) {
      const leases = new GitLeases(clone);
      return { ...base, cloneDir: clone, config, leases: () => leases.held() };
    }
    const dir = configMirrorDir(repo, env);
    const shipped = mirroredConfig(dir, repo);
    const leases = () => Promise.reject(new Error("leases are listed on the repo's runner, not this plane"));
    return shipped && { ...base, cloneDir: dir, config: shipped, readOnly: true, leases };
  };
}

export const NO_PROJECT =
  "Start the dashboard with --repo-dir (or `factory up`) to see this repo's workflows and runtimes.";

export function workflowsView(report: HarnessReport) {
  return {
    problems: report.problems.map(plain),
    workflows: report.entries.map((e) => ({
      name: plain(e.name),
      source: e.source,
      routedTypes: e.routedTypes.map(plain),
      problems: e.problems.map(plain),
      steps: e.workflow
        ? Object.values(e.workflow.steps).map((s) => ({
            id: plain(s.id),
            uses: plain(s.uses),
            runtime: s.runtime ? plain(s.runtime) : null,
          }))
        : [],
      cron: e.workflow
        ? e.workflow.triggers.cron.map((c) => ({ schedule: plain(c.cron.src), tz: plain(c.tz), title: plain(c.title) }))
        : [],
      events: e.workflow ? e.workflow.triggers.event.map(plain) : [],
    })),
  };
}

function target(spec: RuntimeSpec): string {
  switch (spec.kind) {
    case "local":
      return "this machine";
    case "docker":
      return spec.image;
    case "ssh":
      return `${spec.host}:${spec.dir}`;
    case "lwpr":
      return spec.app ? `lwpr app ${spec.app}` : "the lwpr build box";
    case "wrap":
      return spec.argv.join(" ");
    case "http":
      return spec.url;
    case "agent37":
      return `agent37 instance ${spec.instance}`;
    case "microsandbox":
      return `microsandbox ${spec.image}`;
    case "codespaces":
      return `codespace ${spec.codespace}`;
    case "pool":
      return `pool of ${spec.members.map((m) => m.runtime).join(", ")}, then ${spec.fallback ?? "local"}`;
  }
}

export function settingsView(
  project: DashboardProject,
  report: HarnessReport,
  leases: Awaited<ReturnType<DashboardProject["leases"]>> | Error,
  now: number,
) {
  const refs = [
    ...runtimeRefs(project.config, {}),
    ...report.entries.flatMap((e) =>
      e.workflow ? runtimeRefs({}, e.workflow.steps).map((r) => ({ ...r, where: `${e.name}: ${r.where}` })) : [],
    ),
  ];
  const specs = runtimeSpecs(project.machine.runtimes);
  return {
    slots: project.machine.slots,
    slotsInUse: project.fleet?.holders().length ?? 0,
    machines: fleetView(project.fleet?.machines() ?? [], now),
    dailyUsd: project.machine.dailyUsd ?? null,
    runtimes: Object.entries(specs).map(([name, spec]) => ({
      name: plain(name),
      kind: spec.kind,
      builtin: name === DEFAULT_RUNTIME || Object.hasOwn(builtinRuntimes(), name),
      target: plain(target(spec)),
      usedBy: refs.filter((r) => r.name === name).map((r) => plain(r.where)),
    })),
    leasesError: leases instanceof Error ? plain(leases.message) : null,
    leases:
      leases instanceof Error
        ? []
        : leases.map((l) => ({
            key: plain(l.key),
            holder: plain(l.holder),
            expiresAt: l.expiresAt,
            live: l.expiresAt > now,
          })),
  };
}

// The Settings page: the view above plus a cached probe of each runtime the repo uses.
export function settingsWithHealth() {
  const health = healthCache();
  return async (...args: Parameters<typeof settingsView>) => {
    const view = settingsView(...args);
    return { ...view, health: await health(args[0], view.runtimes) };
  };
}

// The Agents page: each agent a repo configures, with its installed version and doctor rows.
// Probing spawns `--version`, so each repo's answer is cached for a minute and shared by concurrent requests.
export function agentsProbe(probes: { which: typeof which; versionOf: typeof versionOf }) {
  const cache = new Map<string, { at: number; rows: Promise<unknown[]> }>();
  const probe = (fleet: Pick<FactoryConfig, "agents" | "stages">, local: boolean) =>
    Promise.all(
      agentCatalog(fleet.agents, fleet.stages).map(async (a) => {
        const row = { ...a, name: plain(a.name), binary: plain(a.binary) };
        if (!a.configured || !local) return { ...row, installed: null, version: null, checks: [] };
        const checks = await agentChecks(a.name, fleet.agents, probes);
        const installed = await probes.which(a.binary);
        const version = installed ? ((await probes.versionOf(a.binary)) ?? "").split("\n")[0]!.trim() || null : null;
        return {
          ...row,
          installed,
          version: version === null ? null : plain(version),
          checks: checks.map((c) => ({
            name: plain(c.name),
            ok: c.ok,
            warn: c.warn === true,
            detail: plain(c.detail),
          })),
        };
      }),
    );
  // A mirrored config is any bucket writer's word and runs on another machine, so the plane never
  // runs the binaries it names.
  type Fleet = Pick<FactoryConfig, "agents" | "stages">;
  return (repo: string, project: { config: Fleet; readOnly?: true } | null | undefined, fallback: Fleet) => {
    const hit = cache.get(repo);
    if (hit && Date.now() - hit.at < 60_000) return hit.rows;
    const rows: Promise<unknown[]> = probe(project?.config ?? fallback, !project?.readOnly);
    cache.set(repo, { at: Date.now(), rows });
    rows.catch(() => cache.delete(repo));
    return rows;
  };
}
