// The CLI's runtime and run-anywhere commands: `factory pool`, `factory runtime`, `factory dispatch`
// and `factory routine`. src/cli.ts dispatches here so it stays a thin switch.

import { SqliteUsageStore } from "./adapters/pool/execution";
import { successJson, UsageError, EXIT } from "./cli-output";
import { loadConfig } from "./config";
import { monthKey, poolReport } from "./core/sandbox-pool";
import { plain } from "./display";
import { cloudRoutine, dispatchJobs, writeActionsOutput } from "./dispatch";
import { loadMachineConfig } from "./machine";
import { formatKit, probeRuntime, verifyRuntime } from "./runtime-kit";
import { defaultRuntime, poolDbPath, runtimeSpecs, runtimesFrom } from "./runtimes";
import { capabilitiesOf } from "./sandbox";
import { makeScm } from "./scm";

export interface CliContext {
  readonly args: readonly string[];
  flag(name: string): string | undefined;
  has(name: string): boolean;
  resolveCloneDir(): Promise<string>;
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
  const result = await dispatchJobs(makeScm(config), config.repo, {
    maxOpenFactoryPrs: config.maxOpenFactoryPrs,
    capabilities: loadMachineConfig().capabilities,
  });
  writeActionsOutput(result, process.env.GITHUB_OUTPUT);
  if (cli.has("json")) return void console.log(successJson(result, true));
  if (result.paused) console.log(`factory dispatch: intake paused, ${result.paused}`);
  for (const j of result.jobs) console.log(`#${j.issue} ${j.label}`);
  if (!result.jobs.length) console.log("factory dispatch: nothing to run");
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
