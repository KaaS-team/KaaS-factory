// The Workflows and Settings pages: what `factory harness inventory` and
// `validate` say about the repo's workflows, and the runtimes and issue leases
// this machine and remote hold. Read-only, built from the same functions the
// CLI uses, so the page and the terminal cannot disagree.

import type { FactoryConfig } from "../src/config";
import { plain } from "../src/display";
import type { HarnessReport } from "../src/harness";
import type { MachineConfig } from "../src/machine";
import { BUILTIN_RUNTIMES, type RuntimeSpec, runtimeRefs } from "../src/runtimes";

// What the dashboard needs to know about the repo it serves. Absent when it
// was started without --repo-dir: the pages then say so instead of guessing.
export interface DashboardProject {
  readonly cloneDir: string;
  readonly config: FactoryConfig;
  readonly machine: MachineConfig;
  // Every lease ref on the remote; GitLeases.held in production.
  readonly leases: () => Promise<ReadonlyArray<{ key: string; holder: string; expiresAt: number }>>;
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
  const specs: Record<string, RuntimeSpec> = { ...BUILTIN_RUNTIMES, ...(project.machine.runtimes ?? {}) };
  return {
    slots: project.machine.slots,
    dailyUsd: project.machine.dailyUsd ?? null,
    runtimes: Object.entries(specs).map(([name, spec]) => ({
      name: plain(name),
      kind: spec.kind,
      builtin: Object.hasOwn(BUILTIN_RUNTIMES, name),
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
