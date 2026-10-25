// Concurrency belongs to the machine, not the repo (plan v2.7.0 item 5): a
// repo's own `concurrency` is a cap, never a guarantee, because two watchers
// on one machine (splitbill-demo and lwp-website) share the same cores and
// the same wallet. The machine-wide count comes from FACTORY_SLOTS, or
// FACTORY_HOME/machine.json, validated at boot like every other config.
// Slots themselves are leases in FACTORY_HOME/machine.db (SQLite, BEGIN
// IMMEDIATE), so two separate processes see and respect the same pool.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { cpus, freemem } from "node:os";
import { dirname } from "node:path";
import { factoryHome } from "./paths";
import type { MicrosandboxSpec } from "./adapters/microsandbox/execution";
import { type RuntimeSpec, runtimeProblems } from "./runtimes";
import { GATEWAY_KEY_ENV, isProviderHost, type LlmGateway } from "./agents/gateway";

export interface MachineConfig {
  readonly slots: number;
  readonly dailyUsd?: number;
  // Named places a gate or check command can run; see src/runtimes.ts.
  readonly runtimes?: Readonly<Record<string, RuntimeSpec>>;
  // A microsandbox runtime in `runtimes` that every agent stage on this machine runs in.
  readonly agentRuntime?: string;
  // A LiteLLM gateway every agent stage calls through, on a key capped at the stage's budget.
  readonly llmGateway?: { readonly url: string };
  // What this machine has (gpu, macos, docker): an issue labelled `needs:<cap>` waits for one that has it.
  readonly capabilities?: readonly string[];
}

const DEFAULT_SLOTS = 2;

function machineConfigPath(env: NodeJS.ProcessEnv): string {
  return `${factoryHome(env)}/machine.json`;
}

function machineDbPath(env: NodeJS.ProcessEnv): string {
  return `${factoryHome(env)}/machine.db`;
}

function positiveInt(value: unknown, where: string): number {
  if (!Number.isInteger(value) || (value as number) < 1)
    throw new Error(`${where} must be a positive integer, got ${JSON.stringify(value)}`);
  return value as number;
}

// FACTORY_SLOTS wins over machine.json's slots and nothing else, so it never
// drops the file's runtimes or agentRuntime; naming neither runs with
// DEFAULT_SLOTS. A value that is present but not a positive integer refuses
// to start rather than silently running unbounded (NaN turns every cap off).
export function loadMachineConfig(env: NodeJS.ProcessEnv = process.env): MachineConfig {
  const fromEnv = env.FACTORY_SLOTS === undefined ? undefined : positiveInt(Number(env.FACTORY_SLOTS), "FACTORY_SLOTS");
  const path = machineConfigPath(env);
  if (!existsSync(path)) return { slots: fromEnv ?? DEFAULT_SLOTS };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const slots = fromEnv ?? positiveInt(raw.slots, `${path}: "slots"`);
  if (raw.dailyUsd !== undefined && !(typeof raw.dailyUsd === "number" && raw.dailyUsd > 0)) {
    throw new Error(`${path}: "dailyUsd" must be a positive number, got ${JSON.stringify(raw.dailyUsd)}`);
  }
  if (raw.runtimes !== undefined) {
    const problems = runtimeProblems(raw.runtimes, `${path}: runtimes`);
    if (problems.length) throw new Error(problems.join("\n"));
  }
  if (raw.agentRuntime !== undefined) {
    const named = (raw.runtimes as Record<string, RuntimeSpec> | undefined)?.[raw.agentRuntime as string];
    if (named?.kind !== "microsandbox")
      throw new Error(
        `${path}: "agentRuntime" must name a microsandbox runtime in "runtimes", got ${JSON.stringify(raw.agentRuntime)}`,
      );
  }
  if (raw.llmGateway !== undefined) gatewayProblem(raw, path);
  if (
    raw.capabilities !== undefined &&
    !(Array.isArray(raw.capabilities) && raw.capabilities.every((c) => typeof c === "string" && CAPABILITY.test(c)))
  )
    throw new Error(
      `${path}: "capabilities" must be a list of lowercase names, got ${JSON.stringify(raw.capabilities)}`,
    );
  return {
    slots,
    ...(raw.llmGateway ? { llmGateway: raw.llmGateway as { url: string } } : {}),
    dailyUsd: raw.dailyUsd as number | undefined,
    ...(raw.agentRuntime ? { agentRuntime: raw.agentRuntime as string } : {}),
    ...(raw.runtimes ? { runtimes: raw.runtimes as Record<string, RuntimeSpec> } : {}),
    ...(raw.capabilities ? { capabilities: raw.capabilities as string[] } : {}),
  };
}

const CAPABILITY = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const NEEDS_PREFIX = "needs:";

// An issue this machine lacks a `needs:` capability for is left for another machine to claim.
export function canServe(capabilities: readonly string[] | undefined, labels: readonly { name: string }[]): boolean {
  const has = new Set(capabilities ?? []);
  return labels.every((l) => !l.name.startsWith(NEEDS_PREFIX) || has.has(l.name.slice(NEEDS_PREFIX.length)));
}

// Plain http only to this machine: anywhere else the minted keys would cross the network in the clear.
function gatewayProblem(raw: Record<string, unknown>, path: string): void {
  const url = (raw.llmGateway as { url?: unknown } | null)?.url;
  let parsed: URL | undefined;
  try {
    parsed = typeof url === "string" ? new URL(url) : undefined;
  } catch {}
  const local = parsed?.hostname === "127.0.0.1" || parsed?.hostname === "localhost";
  if (!parsed || !(parsed.protocol === "https:" || (parsed.protocol === "http:" && local)))
    throw new Error(`${path}: "llmGateway.url" must be an https URL, got ${JSON.stringify(url)}`);
  const vm = raw.agentRuntime
    ? (raw.runtimes as Record<string, MicrosandboxSpec>)[raw.agentRuntime as string]
    : undefined;
  if (vm && !(vm.allow ?? []).includes(parsed.hostname))
    throw new Error(`${path}: the agentRuntime's "allow" must list the llmGateway host ${parsed.hostname}`);
  const around = vm?.allow?.find(isProviderHost);
  if (around)
    throw new Error(
      `${path}: with an llmGateway the agentRuntime may not allow ${around}, a model API it could call around it`,
    );
}

// The gateway with its master key, which only this process holds. Named without a key, it refuses to start.
export function machineGateway(m: MachineConfig, env: NodeJS.ProcessEnv = process.env): LlmGateway | undefined {
  if (!m.llmGateway) return undefined;
  const masterKey = env[GATEWAY_KEY_ENV];
  if (!masterKey) throw new Error(`machine.json names an llmGateway, and ${GATEWAY_KEY_ENV} is not set`);
  return { url: m.llmGateway.url, masterKey };
}

// The VM every agent stage runs in, when machine.json names one.
export function agentVm(m: MachineConfig): MicrosandboxSpec | undefined {
  const spec = m.agentRuntime ? m.runtimes?.[m.agentRuntime] : undefined;
  return spec?.kind === "microsandbox" ? spec : undefined;
}

// Advice only (`factory doctor` prints it, nothing enforces it): roughly one
// slot per 2 cores and one per 2 GiB free, whichever is scarcer, floor 1.
export function suggestSlots(): number {
  const cores = cpus().length;
  const freeGb = freemem() / 1024 ** 3;
  return Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(freeGb / 2)) || 1);
}

function alive(pid: number): boolean {
  try {
    // Signal 0 checks existence without actually signalling the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Machine-wide slot leases, shared by every watcher process that points
// FACTORY_HOME at the same place. A lease is a row; holding one means having
// its id. A process that dies without releasing leaves an orphan row, which
// the next acquire() reclaims by checking whether its pid is still alive.
export class MachineLeases {
  private readonly db: Database;

  constructor(path: string = machineDbPath(process.env)) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        holder TEXT NOT NULL,
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL
      );
    `);
  }

  private reclaimDead(): void {
    const rows = this.db.query("SELECT id, pid FROM leases").all() as { id: number; pid: number }[];
    for (const r of rows) {
      if (!alive(r.pid)) this.db.query("DELETE FROM leases WHERE id = $id").run({ $id: r.id });
    }
  }

  // After reclaiming any lease whose pid has died.
  held(): number {
    this.reclaimDead();
    return (this.db.query("SELECT COUNT(*) AS n FROM leases").get() as { n: number }).n;
  }

  // Count-then-insert inside one BEGIN IMMEDIATE transaction, so two
  // processes racing for the last slot never both succeed (the same shape as
  // git.ts's compare-and-swap push). Returns the lease id to release later,
  // or undefined when every slot is already held.
  acquire(holder: string, slots: number, pid: number = process.pid): number | undefined {
    return this.db
      .transaction(() => {
        this.reclaimDead();
        const n = (this.db.query("SELECT COUNT(*) AS n FROM leases").get() as { n: number }).n;
        if (n >= slots) return undefined;
        const row = this.db
          .query("INSERT INTO leases (holder, pid, acquired_at) VALUES ($holder, $pid, $now) RETURNING id")
          .get({ $holder: holder, $pid: pid, $now: new Date().toISOString() }) as { id: number };
        return row.id;
      })
      .immediate();
  }

  release(leaseId: number): void {
    this.db.query("DELETE FROM leases WHERE id = $id").run({ $id: leaseId });
  }

  close(): void {
    this.db.close();
  }
}

// The smaller of the machine's own cap and this repo's own config.concurrency
// (plan v2.7.0 item 5: "repo concurrency becomes a cap for that repo").
export function effectiveSlots(repoConcurrency: number, machine: MachineConfig): number {
  return Math.min(repoConcurrency, machine.slots);
}

// The machine's own dailyUsd cap (plan v2.7.0 item 7) is a cap on every
// repo's spend together, but each repo keeps its own stage_runs in its own
// FactoryState db (plan v2.6.2 item 1) — so it needs a ledger of its own,
// shared the same way MachineLeases shares slots: one table in machine.db,
// written by every watcher process that points FACTORY_HOME here.
export class MachineSpend {
  private readonly db: Database;

  constructor(path: string = machineDbPath(process.env)) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spend (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        cost_usd REAL NOT NULL,
        recorded_at TEXT NOT NULL
      );
    `);
  }

  // Only a known cost is recorded: an unreported run counts against a repo's
  // own maxUnreportedRuns cap (state.ts), never silently as $0 here.
  record(repo: string, costUsd: number): void {
    this.db
      .query("INSERT INTO spend (repo, cost_usd, recorded_at) VALUES ($repo, $cost, $now)")
      .run({ $repo: repo, $cost: costUsd, $now: new Date().toISOString() });
  }

  todayUsd(): number {
    const since = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    return (
      this.db
        .query("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM spend WHERE recorded_at >= $since")
        .get({ $since: since }) as { n: number }
    ).n;
  }

  close(): void {
    this.db.close();
  }
}
