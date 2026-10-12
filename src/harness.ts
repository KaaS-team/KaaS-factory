// `factory harness`: what a repo's workflows are and whether they hold together. `validate` loads
// every workflow file (the repo's and the runner's) and every one the config names, as the watcher
// would at boot; `inventory` lists each one's steps, triggers and the issue types routed to it.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig } from "./config";
import type { Workflow } from "./core/workflow";
import { BUNDLED_DIR, loadWorkflow, parseWorkflowText } from "./engine/workflows";

export interface HarnessEntry {
  readonly name: string;
  readonly source: "repo" | "runner";
  readonly workflow?: Workflow;
  readonly problems: readonly string[];
  // Issue types whose route names it; "*" when it is the repo's own (config.workflow).
  readonly routedTypes: readonly string[];
}

export interface HarnessReport {
  readonly entries: readonly HarnessEntry[];
  readonly problems: readonly string[];
}

const ymlIn = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".yml")).map((f) => f.slice(0, -4)).sort();
  } catch {
    return [];
  }
};

export async function harnessReport(cloneDir: string, config: Pick<FactoryConfig, "workflow" | "routes">, bundledDir: string = BUNDLED_DIR): Promise<HarnessReport> {
  const routed = new Map<string, string[]>([[config.workflow, ["*"]]]);
  for (const [type, route] of Object.entries(config.routes ?? {})) {
    if (type.startsWith("_") || !route?.workflow) continue;
    routed.set(route.workflow, [...(routed.get(route.workflow) ?? []), type]);
  }
  const repoDir = join(cloneDir, ".factory", "workflows");
  const repoNames = ymlIn(repoDir);
  const entries: HarnessEntry[] = [];
  const problems: string[] = [];
  const add = (name: string, source: HarnessEntry["source"], text: string) => {
    const parsed = parseWorkflowText(text);
    const own = parsed.ok ? (parsed.workflow.name === name ? [] : [`name: is "${parsed.workflow.name}", but the file is ${name}.yml`]) : parsed.problems;
    entries.push({ name, source, ...(parsed.ok ? { workflow: parsed.workflow } : {}), problems: own, routedTypes: routed.get(name) ?? [] });
    for (const p of own) problems.push(`${source === "repo" ? ".factory/workflows" : "runner"}/${name}.yml: ${p}`);
  };
  for (const name of repoNames) add(name, "repo", await Bun.file(join(repoDir, `${name}.yml`)).text());
  // A runner workflow the repo overrides is not what runs, so it is not listed.
  for (const name of ymlIn(bundledDir).filter((n) => !repoNames.includes(n))) add(name, "runner", await Bun.file(join(bundledDir, `${name}.yml`)).text());
  for (const [name, types] of routed) {
    if (entries.some((e) => e.name === name)) continue;
    const loaded = await loadWorkflow(cloneDir, name);
    const where = types.includes("*") ? "workflow" : types.map((t) => `routes.${t}.workflow`).join(", ");
    problems.push(`${where}: ${loaded.ok ? `"${name}" loads, but not from .factory/workflows/ or the runner` : loaded.problems.join("; ")}`);
  }
  return { entries, problems };
}

export function formatInventory(report: HarnessReport): string[] {
  const lines: string[] = [];
  for (const e of report.entries) {
    const runs = e.routedTypes.includes("*") ? "the repo's workflow" : e.routedTypes.length ? `types: ${e.routedTypes.join(", ")}` : "not routed";
    lines.push(`${e.name} (${e.source}; ${runs})${e.problems.length ? " INVALID" : ""}`);
    if (!e.workflow) continue;
    lines.push(`  steps: ${Object.values(e.workflow.steps).map((s) => (s.uses === s.id ? s.id : `${s.id}(${s.uses})`)).join(" -> ")}`);
    for (const c of e.workflow.triggers.cron) lines.push(`  cron: ${c.cron.src} ${c.tz}: ${c.title}`);
    for (const t of e.workflow.triggers.event) lines.push(`  event: ${t}`);
  }
  return lines;
}
