// ExecutionPort over a pool of hosted sandboxes on free tiers (see
// src/core/sandbox-pool.ts for the routing). Usage lives in
// FACTORY_HOME/machine.db, so every watcher on the machine counts against the
// same allowance: a run reserves its minutes in one BEGIN IMMEDIATE
// transaction, and settles what it used when it ends. A member that fails as
// a runtime (unreachable, refused) is charged what it took and keeps its
// error, and the run moves on to the next one; a command that fails on a
// member is that run's answer. With every member spent or failed, the run
// goes to `fallback` when the pool names one.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_RESERVE_MIN, grant, type MemberMonth, monthKey, type PoolMember } from "../../core/sandbox-pool";
import type { ExecResult, ExecutionPort } from "../../ports/execution";

export interface PoolSpec {
  readonly kind: "pool";
  readonly members: readonly PoolMember[];
  readonly reserveMin?: number;
  // A runtime name, or "none" to fail the step instead (default "local").
  readonly fallback?: string;
}

export interface Hold {
  readonly id: number;
  readonly minutes: number;
}

export interface UsageStore {
  // Holds `member`'s grant for this month atomically, or undefined when it has too few minutes left.
  reserve(month: string, member: PoolMember, reserveMin: number): Hold | undefined;
  settle(hold: Hold, used: number, failure?: string): void;
  month(month: string): Record<string, MemberMonth>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class SqliteUsageStore implements UsageStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pool_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month TEXT NOT NULL,
        member TEXT NOT NULL,
        held REAL NOT NULL,
        used REAL,
        failure TEXT,
        pid INTEGER NOT NULL,
        at TEXT NOT NULL
      );
    `);
  }

  // A run whose process died never settles: it is charged everything it held.
  private reclaimDead(): void {
    const open = this.db.query("SELECT id, pid FROM pool_runs WHERE used IS NULL").all() as {
      id: number;
      pid: number;
    }[];
    for (const r of open)
      if (!alive(r.pid)) this.db.query("UPDATE pool_runs SET used = held WHERE id = $id").run({ $id: r.id });
  }

  month(month: string): Record<string, MemberMonth> {
    this.reclaimDead();
    const rows = this.db
      .query(
        `SELECT member, COALESCE(SUM(used), 0) AS used, COALESCE(SUM(CASE WHEN used IS NULL THEN held END), 0) AS held,
           (SELECT failure FROM pool_runs f WHERE f.member = r.member AND f.month = $m AND f.failure IS NOT NULL
            ORDER BY f.id DESC LIMIT 1) AS failure
         FROM pool_runs r WHERE month = $m GROUP BY member`,
      )
      .all({ $m: month }) as { member: string; used: number; held: number; failure: string | null }[];
    return Object.fromEntries(
      rows.map((r) => [r.member, { used: r.used, held: r.held, ...(r.failure ? { lastFailure: r.failure } : {}) }]),
    );
  }

  reserve(month: string, member: PoolMember, reserveMin: number): Hold | undefined {
    return this.db
      .transaction(() => {
        const minutes = grant(member, this.month(month)[member.runtime], reserveMin);
        if (!minutes) return undefined;
        const row = this.db
          .query(
            "INSERT INTO pool_runs (month, member, held, pid, at) VALUES ($m, $member, $held, $pid, $at) RETURNING id",
          )
          .get({
            $m: month,
            $member: member.runtime,
            $held: minutes,
            $pid: process.pid,
            $at: new Date().toISOString(),
          }) as { id: number };
        return { id: row.id, minutes };
      })
      .immediate();
  }

  settle(hold: Hold, used: number, failure?: string): void {
    this.db
      .query("UPDATE pool_runs SET used = $used, failure = $failure WHERE id = $id")
      .run({ $id: hold.id, $used: Math.min(used, hold.minutes), $failure: failure ?? null });
  }

  close(): void {
    this.db.close();
  }
}

export class PoolExecution implements ExecutionPort {
  constructor(
    private readonly spec: PoolSpec,
    private readonly ports: Readonly<Record<string, ExecutionPort>>,
    // The port `spec.fallback` names, or undefined for "none".
    private readonly fallback: ExecutionPort | undefined,
    private readonly store: UsageStore,
    private readonly now: () => Date = () => new Date(),
    // Tests shrink a minute so a cut-off lands inside them.
    private readonly msPerMinute = 60_000,
  ) {}

  async run(cmd: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    const month = monthKey(this.now());
    const failures: string[] = [];
    for (const m of this.spec.members) {
      const hold = this.store.reserve(month, m, this.spec.reserveMin ?? DEFAULT_RESERVE_MIN);
      if (!hold) continue;
      const cut = AbortSignal.timeout(hold.minutes * this.msPerMinute);
      const started = this.now().getTime();
      let r: ExecResult;
      try {
        r = await this.ports[m.runtime]!.run(cmd, cwd, signal ? AbortSignal.any([signal, cut]) : cut);
      } catch (err) {
        // A member that throws still settles, so its hold never outlives the run.
        const why = `threw: ${err instanceof Error ? err.message : String(err)}`;
        r = { stdout: "", stderr: why, code: 1, runtimeFailed: why };
      }
      this.store.settle(hold, (this.now().getTime() - started) / this.msPerMinute, r.runtimeFailed);
      if (!r.runtimeFailed || signal?.aborted || cut.aborted) return r;
      failures.push(`${m.runtime}: ${r.runtimeFailed}`);
    }
    const why = failures.length ? failures.join("; ") : "every member is spent this month";
    if (!this.fallback) return { stdout: "", stderr: `pool: ${why}; no fallback`, code: 1, runtimeFailed: why };
    const r = await this.fallback.run(cmd, cwd, signal);
    return { ...r, stderr: `pool: ${why}; ran on ${this.spec.fallback ?? "local"}\n${r.stderr}` };
  }
}
