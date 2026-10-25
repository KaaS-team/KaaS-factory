// ExecutionPort over a pool of hosted sandboxes on free tiers (see
// src/core/sandbox-pool.ts for the routing). Usage lives in
// FACTORY_HOME/pool-usage.json, so every watcher on the machine counts
// against the same allowance. A member that fails as a runtime (unreachable,
// refused) gets the minutes it spent and its error, and the run moves on to
// the next one; a command that fails on a member is that run's answer.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_RESERVE_MIN,
  eligible,
  minutesLeft,
  monthKey,
  type PoolMember,
  type PoolUsage,
  withRun,
} from "../../core/sandbox-pool";
import type { ExecResult, ExecutionPort } from "../../ports/execution";

export interface PoolSpec {
  readonly kind: "pool";
  readonly members: readonly PoolMember[];
  readonly reserveMin?: number;
}

export interface UsageStore {
  read(): PoolUsage;
  write(usage: PoolUsage): void;
}

export class FileUsageStore implements UsageStore {
  constructor(private readonly path: string) {}
  read(): PoolUsage {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as PoolUsage) : {};
  }
  write(usage: PoolUsage): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(usage, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}

export class PoolExecution implements ExecutionPort {
  constructor(
    private readonly spec: PoolSpec,
    private readonly ports: Readonly<Record<string, ExecutionPort>>,
    private readonly fallback: ExecutionPort,
    private readonly store: UsageStore,
    private readonly now: () => Date = () => new Date(),
    // Tests shrink a minute so a cut-off lands inside them.
    private readonly msPerMinute = 60_000,
  ) {}

  async run(cmd: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    const month = monthKey(this.now());
    const failures: string[] = [];
    for (const m of eligible(
      this.spec.members,
      this.store.read(),
      month,
      this.spec.reserveMin ?? DEFAULT_RESERVE_MIN,
    )) {
      const left = minutesLeft(m, this.store.read(), month);
      const cut = AbortSignal.timeout(left * this.msPerMinute);
      const started = this.now().getTime();
      const r = await this.ports[m.runtime]!.run(cmd, cwd, signal ? AbortSignal.any([signal, cut]) : cut);
      const used = Math.min(left, (this.now().getTime() - started) / this.msPerMinute);
      this.store.write(withRun(this.store.read(), month, m.runtime, used, r.runtimeFailed));
      if (!r.runtimeFailed || signal?.aborted || cut.aborted) return r;
      failures.push(`${m.runtime}: ${r.runtimeFailed}`);
    }
    const r = await this.fallback.run(cmd, cwd, signal);
    return failures.length ? { ...r, stderr: `pool: ${failures.join("; ")}; ran locally\n${r.stderr}` } : r;
  }
}
