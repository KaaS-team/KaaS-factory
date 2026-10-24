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
import { type RuntimeSpec, runtimeProblems } from "./runtimes";

export interface MachineConfig {
  readonly slots: number;
  readonly dailyUsd?: number;
  // Named places a gate or check command can run; see src/runtimes.ts.
  readonly runtimes?: Readonly<Record<string, RuntimeSpec>>;
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

// FACTORY_SLOTS wins over machine.json; naming neither runs with
// DEFAULT_SLOTS. A value that is present but not a positive integer refuses
// to start rather than silently running unbounded (NaN turns every cap off).
export function loadMachineConfig(env: NodeJS.ProcessEnv = process.env): MachineConfig {
  if (env.FACTORY_SLOTS !== undefined) {
    return { slots: positiveInt(Number(env.FACTORY_SLOTS), "FACTORY_SLOTS") };
  }
  const path = machineConfigPath(env);
  if (!existsSync(path)) return { slots: DEFAULT_SLOTS };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const slots = positiveInt(raw.slots, `${path}: "slots"`);
  if (raw.dailyUsd !== undefined && !(typeof raw.dailyUsd === "number" && raw.dailyUsd > 0)) {
    throw new Error(`${path}: "dailyUsd" must be a positive number, got ${JSON.stringify(raw.dailyUsd)}`);
  }
  if (raw.runtimes !== undefined) {
    const problems = runtimeProblems(raw.runtimes, `${path}: runtimes`);
    if (problems.length) throw new Error(problems.join("\n"));
  }
  return {
    slots,
    dailyUsd: raw.dailyUsd as number | undefined,
    ...(raw.runtimes ? { runtimes: raw.runtimes as Record<string, RuntimeSpec> } : {}),
  };
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
