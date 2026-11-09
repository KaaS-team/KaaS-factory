// The CLI's runtime and run-anywhere commands: `factory pool`, `factory runtime`, `factory dispatch`,
// `factory routine` and `factory plan-order`. src/cli.ts dispatches here so it stays a thin switch.

import { schedNode } from "./blockers";
import { SqliteUsageStore } from "./adapters/pool/execution";
import { successJson, UsageError, EXIT } from "./cli-output";
import { loadConfig, type FactoryConfig } from "./config";
import type { WatchDeps } from "./engine/common";
import { monthKey, poolReport } from "./core/sandbox-pool";
import { parseMeta, type Schedule, schedule } from "./core/schedule";
import { plain } from "./display";
import { cloudRoutine, dispatchJobs, writeActionsOutput } from "./dispatch";
import type { GhIssue, ScmPort } from "./github";
import { loadMachineConfig } from "./machine";
import { formatKit, probeRuntime, verifyRuntime } from "./runtime-kit";
import { defaultRuntime, poolDbPath, runtimeSpecs, runtimesFrom } from "./runtimes";
import { capabilitiesOf } from "./sandbox";

export interface CliContext {
  readonly args: readonly string[];
  flag(name: string): string | undefined;
  has(name: string): boolean;
  resolveCloneDir(): Promise<string>;
  watchDeps(cloneDir: string, config: FactoryConfig): Promise<WatchDeps>;
}

// `factory pool`: each pool in machine.json, its members' minutes used and left this month, and the last failure.
export async function cmdPool(cli: CliContext): Promise<void> {
  if (cli.has("help")) return void console.log("usage: factory pool [--json]");
  const runtimes = loadMachineConfig().runtimes ?? {};
  const month = monthKey(new Date());
  const specs = Object.entries(runtimes).flatMap(([name, spec]) => (spec.kind === "pool" ? [{ name, spec }] : []));
  const usage = specs.length ? new SqliteUsageStore(poolDbPath()).month(month) : {};
  const pools = specs.map(({ name, spec }) => ({
    name,
    fallback: spec.fallback ?? "local",
    members: poolReport(spec.members, usage),
  }));
  if (cli.has("json")) return void console.log(successJson({ month, pools }));
  if (!pools.length) return void console.log("factory pool: no pool runtime in FACTORY_HOME/machine.json");
  for (const p of pools) {
    console.log(`${p.name} (${month}, then ${p.fallback})`);
    for (const m of p.members)
      console.log(
        `  ${m.runtime}  used ${m.used} of ${m.allowance} min, ${m.left} left${m.lastFailure ? `  last failure: ${plain(m.lastFailure)}` : ""}`,
      );
  }
}

const RUNTIME_USAGE = "usage: factory runtime (list [--probe] | verify <name>) [--json]";

// `factory runtime list`: every runtime, its kind and capability flags, and with --probe whether it answers.
// `factory runtime verify <name>`: the shared conformance kit (src/runtime-kit.ts) against that runtime.
export async function cmdRuntime(cli: CliContext): Promise<void> {
  const [, sub, name] = cli.args;
  const machine = loadMachineConfig().runtimes;
  const specs = runtimeSpecs(machine);
  const ports = runtimesFrom(machine);
  if (sub === "list") {
    const rows = await Promise.all(
      Object.entries(specs).map(async ([n, spec]) => ({
        name: n,
        kind: spec.kind,
        capabilities: capabilitiesOf(spec),
        ...(cli.has("probe") ? { health: await probeRuntime(ports[n]!) } : {}),
      })),
    );
    const warning = defaultRuntime().warning;
    if (cli.has("json")) return void console.log(successJson({ runtimes: rows, ...(warning ? { warning } : {}) }));
    for (const r of rows)
      console.log(
        `${r.name}  ${r.kind}  isolation ${r.capabilities.isolation}, egress ${r.capabilities.egress}${r.health ? `  ${r.health.ok ? "up" : "DOWN"} (${plain(r.health.detail)}, ${r.health.ms} ms)` : ""}`,
      );
    if (warning) console.log(`warning: ${warning}`);
    return;
  }
  if (sub !== "verify" || !name || name.startsWith("--")) throw new UsageError(RUNTIME_USAGE);
  const spec = specs[name];
  if (!spec) throw new UsageError(`runtime verify: no runtime "${name}"; known: ${Object.keys(specs).join(", ")}`);
  const checks = await verifyRuntime(ports[name]!, capabilitiesOf(spec));
  const failed = checks.some((c) => !c.ok);
  if (cli.has("json")) console.log(successJson({ runtime: name, checks }, !failed));
  else console.log(formatKit(name, checks));
  if (failed) process.exit(EXIT.checksFailed);
}

// `factory dispatch`: the issues one tick would advance, as an Actions matrix in $GITHUB_OUTPUT.
export async function cmdDispatch(cli: CliContext): Promise<void> {
  const cloneDir = await cli.resolveCloneDir();
  const config = await loadConfig(cloneDir);
  const result = await dispatchJobs(await cli.watchDeps(cloneDir, config), config);
  writeActionsOutput(result, process.env.GITHUB_OUTPUT);
  if (cli.has("json")) return void console.log(successJson(result, true));
  if (result.paused) console.log(`factory dispatch: intake paused, ${result.paused}`);
  for (const j of result.jobs) console.log(`#${j.issue} ${j.label}`);
  if (!result.jobs.length) console.log("factory dispatch: nothing to run");
}

// The `dispatch`, `routine` and `plan-order` commands: one case in src/cli.ts, routed here by name.
export function cmdScheduling(name: string, cli: CliContext): Promise<void> {
  if (name === "dispatch") return cmdDispatch(cli);
  if (name === "routine") return cmdRoutine(cli);
  return cmdPlanOrder(cli);
}

// `factory plan-order`: the order declared issues would start in, the critical path, and why. Exits 1 on a
// dependency cycle or a declared dep that is neither open nor closed as completed, so CI can gate a backlog.
export async function cmdPlanOrder(cli: CliContext): Promise<void> {
  const cloneDir = await cli.resolveCloneDir();
  const config = await loadConfig(cloneDir);
  const { github } = await cli.watchDeps(cloneDir, config);
  const open = await github.listOpenIssues(config.repo);
  const result = await planOrder(github, config.repo, open, config.concurrency);
  const failed = result.cycles.length > 0 || result.missing.length > 0;
  if (cli.has("json")) console.log(successJson(result, !failed));
  else console.log(formatPlanOrder(result, new Map(open.map((i) => [i.number, plain(i.title)] as const))));
  if (failed) process.exit(EXIT.error);
}

// The scheduler's plan over the open issues. Every open issue is a node, as the watcher's dependency gate
// sees them, but only declared issues are listed; a dep that is closed as not planned counts as missing.
async function planOrder(github: ScmPort, repo: string, open: readonly GhIssue[], slots: number): Promise<Schedule> {
  const openNumbers = new Set(open.map((i) => i.number));
  const declared = open.filter((i) => parseMeta(i.body).declared);
  const completed = new Map<number, Promise<boolean>>();
  const isCompleted = (n: number): Promise<boolean> => {
    let known = completed.get(n);
    if (!known) {
      known = github.getIssue(repo, n).then(
        (i) => i.state === "CLOSED" && i.stateReason !== "NOT_PLANNED",
        () => false,
      );
      completed.set(n, known);
    }
    return known;
  };
  const missing: Schedule["missing"] = [];
  for (const issue of declared)
    for (const dep of schedNode(issue).deps)
      if (!openNumbers.has(dep) && !(await isCompleted(dep))) missing.push({ issue: issue.number, dep });
  const plan = schedule({ nodes: open.map(schedNode), open: openNumbers, slots });
  const listed = new Set(declared.map((i) => i.number));
  return { ...plan, order: plan.order.filter((n) => listed.has(n)), missing };
}

// The plain-text plan: one line per issue in start order with its reason, then the critical path, then any
// cycle or missing dep.
export function formatPlanOrder(plan: Schedule, titles: ReadonlyMap<number, string>): string {
  if (plan.order.length === 0 && plan.cycles.length === 0) return "factory plan-order: no declared issues are open";
  const lines = plan.order.map((n, i) => `${i + 1}. ${plan.why[n]}  ${titles.get(n) ?? ""}`.trimEnd());
  if (plan.criticalPath.length) lines.push(`critical path: ${plan.criticalPath.map((n) => `#${n}`).join(" -> ")}`);
  if (plan.cycles.length) lines.push("cycles:", ...plan.cycles.map((c) => `  ${c.map((n) => `#${n}`).join(" -> ")}`));
  if (plan.missing.length)
    lines.push(
      "missing:",
      ...plan.missing.map((m) => `  #${m.issue} depends on #${m.dep}, which is neither open nor closed as completed`),
    );
  return lines.join("\n");
}

// `factory routine`: the Claude Code cloud routine (name, cron, prompt) that runs `factory tick`.
export async function cmdRoutine(cli: CliContext): Promise<void> {
  const repo = cli.flag("repo") ?? (await loadConfig(await cli.resolveCloneDir())).repo;
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
  const routine = cloudRoutine({
    repo,
    runnerRepo: cli.flag("runner-repo") ?? "KaaS-team/KaaS-factory",
    runnerRef: cli.flag("runner-ref") ?? `v${pkg.version}`,
    cron: cli.flag("cron"),
  });
  if (cli.has("json")) return void console.log(successJson(routine, true));
  console.log(`name: ${routine.name}\ncron: ${routine.cron}\nprompt:\n${routine.prompt}`);
}
