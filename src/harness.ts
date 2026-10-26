// `factory harness`: what a repo's workflows are and whether they hold together. `validate` loads
// every workflow file (the repo's and the runner's) and every one the config names, as the watcher
// would at boot; `inventory` lists each one's steps, triggers and the issue types routed to it.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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

// name -> file, for every .yml or .md workflow in a dir; a .yml wins a name both have, as in loadWorkflow.
const workflowsIn = (dir: string): Map<string, string> => {
  try {
    const files = readdirSync(dir)
      .filter((f) => /\.(yml|md)$/.test(f))
      .sort();
    const m = new Map<string, string>();
    for (const f of files)
      if (!m.has(f.replace(/\.(yml|md)$/, "")) || f.endsWith(".yml")) m.set(f.replace(/\.(yml|md)$/, ""), f);
    return new Map([...m].sort(([a], [b]) => a.localeCompare(b)));
  } catch {
    return new Map();
  }
};

export async function harnessReport(
  cloneDir: string,
  config: Pick<FactoryConfig, "workflow" | "routes">,
  bundledDir: string = BUNDLED_DIR,
): Promise<HarnessReport> {
  const routed = new Map<string, string[]>([[config.workflow, ["*"]]]);
  for (const [type, route] of Object.entries(config.routes ?? {})) {
    if (type.startsWith("_") || !route?.workflow) continue;
    routed.set(route.workflow, [...(routed.get(route.workflow) ?? []), type]);
  }
  const repoDir = join(cloneDir, ".factory", "workflows");
  const repoFiles = workflowsIn(repoDir);
  const entries: HarnessEntry[] = [];
  const problems: string[] = [];
  const add = (name: string, source: HarnessEntry["source"], file: string, text: string) => {
    const parsed = parseWorkflowText(text);
    const own = parsed.ok
      ? parsed.workflow.name === name
        ? []
        : [`name: is "${parsed.workflow.name}", but the file is ${file}`]
      : parsed.problems;
    entries.push({
      name,
      source,
      ...(parsed.ok ? { workflow: parsed.workflow } : {}),
      problems: own,
      routedTypes: routed.get(name) ?? [],
    });
    for (const p of own) problems.push(`${source === "repo" ? ".factory/workflows" : "runner"}/${file}: ${p}`);
  };
  for (const [name, file] of repoFiles) add(name, "repo", file, await Bun.file(join(repoDir, file)).text());
  // A runner workflow the repo overrides is not what runs, so it is not listed.
  for (const [name, file] of workflowsIn(bundledDir))
    if (!repoFiles.has(name)) add(name, "runner", file, await Bun.file(join(bundledDir, file)).text());
  for (const [name, types] of routed) {
    if (entries.some((e) => e.name === name)) continue;
    const loaded = await loadWorkflow(cloneDir, name);
    const where = types.includes("*") ? "workflow" : types.map((t) => `routes.${t}.workflow`).join(", ");
    problems.push(
      `${where}: ${loaded.ok ? `"${name}" loads, but not from .factory/workflows/ or the runner` : loaded.problems.join("; ")}`,
    );
  }
  return { entries, problems };
}

export function formatInventory(report: HarnessReport): string[] {
  const lines: string[] = [];
  for (const e of report.entries) {
    const runs = e.routedTypes.includes("*")
      ? "the repo's workflow"
      : e.routedTypes.length
        ? `types: ${e.routedTypes.join(", ")}`
        : "not routed";
    lines.push(`${e.name} (${e.source}; ${runs})${e.problems.length ? " INVALID" : ""}`);
    if (!e.workflow) continue;
    lines.push(
      `  steps: ${Object.values(e.workflow.steps)
        .map((s) => (s.uses === s.id ? s.id : `${s.id}(${s.uses})`))
        .join(" -> ")}`,
    );
    for (const c of e.workflow.triggers.cron) lines.push(`  cron: ${c.cron.src} ${c.tz}: ${c.title}`);
    for (const t of e.workflow.triggers.event) lines.push(`  event: ${t}`);
  }
  return lines;
}

// `factory harness scaffold <name>`: a starting .md workflow, the five built-in stages in order, that
// loads as is. It never overwrites a workflow the repo already has.
export function scaffoldText(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "stages:",
    "  triage: {}",
    "  plan:",
    "    needs: triage",
    "    approval: on-risk:high",
    "  build:",
    "    needs: plan",
    "    gates: [lint, unit]",
    "  verify:",
    "    needs: build",
    "  pr:",
    "    needs: verify",
    "---",
    `When ${name} runs: say which issues it is for. Edit the stages; \`factory harness validate\` checks it.`,
    "",
  ].join("\n");
}

export function scaffoldWorkflow(cloneDir: string, name: string): { path: string } | { problems: string[] } {
  if (!/^[\w-]+$/.test(name)) return { problems: [`"${name}": letters, digits, - and _ only`] };
  const dir = join(cloneDir, ".factory", "workflows");
  const taken = [".yml", ".md"].find((ext) => existsSync(join(dir, `${name}${ext}`)));
  if (taken) return { problems: [`.factory/workflows/${name}${taken} exists; scaffold never overwrites`] };
  const text = scaffoldText(name);
  const parsed = parseWorkflowText(text);
  if (!parsed.ok) return { problems: parsed.problems };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), text);
  return { path: `.factory/workflows/${name}.md` };
}

// `factory harness eval`: how each workflow did on the runs the event log recorded.
export interface WorkflowScore {
  readonly workflow: string;
  readonly runs: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly shippedRate: number;
  // step -> how many times it failed, across every run of the workflow.
  readonly failedSteps: Readonly<Record<string, number>>;
  readonly issues: readonly number[];
  readonly costUsd: number;
}

type EventRow = { readonly type: string; readonly data: string };

export function evalRuns(rows: readonly EventRow[], repo: string, costOf: (issue: number) => number): WorkflowScore[] {
  const by = new Map<
    string,
    { outcomes: Record<string, number>; failed: Record<string, number>; issues: Set<number> }
  >();
  for (const r of rows) {
    if (r.type !== "factory.run.completed" && r.type !== "factory.step.failed") continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(r.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d.repo !== repo || typeof d.workflow !== "string") continue;
    const w = by.get(d.workflow) ?? { outcomes: {}, failed: {}, issues: new Set<number>() };
    by.set(d.workflow, w);
    if (r.type === "factory.step.failed") w.failed[String(d.step)] = (w.failed[String(d.step)] ?? 0) + 1;
    else {
      w.outcomes[String(d.outcome)] = (w.outcomes[String(d.outcome)] ?? 0) + 1;
      if (typeof d.issue === "number") w.issues.add(d.issue);
    }
  }
  return [...by]
    .map(([workflow, w]) => {
      const runs = Object.values(w.outcomes).reduce((a, b) => a + b, 0);
      const issues = [...w.issues].sort((a, b) => a - b);
      return {
        workflow,
        runs,
        outcomes: w.outcomes,
        shippedRate: runs ? (w.outcomes.shipped ?? 0) / runs : 0,
        failedSteps: w.failed,
        issues,
        costUsd: issues.reduce((sum, i) => sum + costOf(i), 0),
      };
    })
    .sort((a, b) => a.workflow.localeCompare(b.workflow));
}

export function formatScores(scores: readonly WorkflowScore[]): string[] {
  if (scores.length === 0) return ["no recorded runs yet"];
  return scores.map((s) => {
    const fails = Object.entries(s.failedSteps).map(([k, n]) => `${k} x${n}`);
    return `${s.workflow}: ${s.runs} runs, ${Math.round(s.shippedRate * 100)}% shipped, $${s.costUsd.toFixed(2)}${fails.length ? `; failed steps: ${fails.join(", ")}` : ""}`;
  });
}
