// The `pool` runtime (spec 10 row sandbox-pool): free sandboxes in order, each
// skipped once this month's minutes are spent, the fallback when all are, and
// never run past an allowance, not even by two runs at once.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpSandboxExecution } from "../src/adapters/http-sandbox/execution";
import { PoolExecution, type PoolSpec, SqliteUsageStore } from "../src/adapters/pool/execution";
import { grant, monthKey, poolReport } from "../src/core/sandbox-pool";
import type { ExecResult, ExecutionPort } from "../src/ports/execution";
import { poolDbPath, runtimeProblems, runtimesFrom } from "../src/runtimes";
import { startSandbox } from "./fixtures/http-sandbox";

const OCT = Date.UTC(2026, 9, 25);
const MONTH = "2026-10";
const spec: PoolSpec = {
  kind: "pool",
  members: [
    { runtime: "e2b", minutes: 60 },
    { runtime: "daytona", minutes: 30 },
  ],
};

// A store where `member` already used `used` minutes this month.
function storeWith(used: Record<string, number> = {}): SqliteUsageStore {
  const store = new SqliteUsageStore(":memory:");
  for (const [runtime, minutes] of Object.entries(used)) {
    const m = spec.members.find((x) => x.runtime === runtime)!;
    store.settle(store.reserve(MONTH, m, 1)!, minutes);
  }
  return store;
}

// A member that answers `result` and takes `minutes` of the fake clock.
function member(result: Partial<ExecResult>, clock: { t: number }, minutes: number) {
  const calls: string[] = [];
  const port: ExecutionPort = {
    async run(cmd) {
      calls.push(cmd);
      clock.t += minutes * 60_000;
      return { stdout: "", stderr: "", code: 0, ...result };
    },
  };
  return { port, calls };
}

function pool(
  store: SqliteUsageStore,
  results: { e2b?: Partial<ExecResult>; daytona?: Partial<ExecResult> } = {},
  withFallback = true,
) {
  const clock = { t: OCT };
  const e2b = member(results.e2b ?? { stdout: "e2b" }, clock, 3);
  const daytona = member(results.daytona ?? { stdout: "daytona" }, clock, 2);
  const local = member({ stdout: "local" }, clock, 1);
  const exec = new PoolExecution(
    withFallback ? spec : { ...spec, fallback: "none" },
    { e2b: e2b.port, daytona: daytona.port },
    withFallback ? local.port : undefined,
    store,
    () => new Date(clock.t),
  );
  return { exec, e2b, daytona, local };
}

describe("sandbox pool", () => {
  test("the first member with minutes left runs, and its minutes are recorded", async () => {
    const store = storeWith();
    const { exec, daytona, local } = pool(store);
    expect((await exec.run("make check", "/w")).stdout).toBe("e2b");
    expect(daytona.calls).toEqual([]);
    expect(local.calls).toEqual([]);
    expect(store.month(MONTH)).toEqual({ e2b: { used: 3, held: 0 } });
  });

  test("a spent member is skipped", async () => {
    const { exec, e2b } = pool(storeWith({ e2b: 55 }));
    expect((await exec.run("make check", "/w")).stdout).toBe("daytona");
    expect(e2b.calls).toEqual([]);
  });

  test("every member spent falls back, and says so", async () => {
    const { exec, e2b, daytona } = pool(storeWith({ e2b: 60, daytona: 25 }));
    const r = await exec.run("make check", "/w");
    expect(r.stdout).toBe("local");
    expect(r.stderr).toStartWith("pool: every member is spent this month; ran on local");
    expect([...e2b.calls, ...daytona.calls]).toEqual([]);
  });

  test('fallback "none" fails the step as a runtime instead of running it here', async () => {
    const r = await pool(storeWith({ e2b: 60, daytona: 30 }), {}, false).exec.run("make check", "/w");
    expect(r.code).toBe(1);
    expect(r.runtimeFailed).toBe("every member is spent this month");
  });

  test("a runtime failure records it and moves on to the next member", async () => {
    const store = storeWith();
    const { exec } = pool(store, { e2b: { code: 1, runtimeFailed: "sandbox answered 429" } });
    expect((await exec.run("make check", "/w")).stdout).toBe("daytona");
    expect(store.month(MONTH).e2b).toEqual({ used: 3, held: 0, lastFailure: "sandbox answered 429" });
  });

  test("a member that throws is settled and skipped", async () => {
    const store = storeWith();
    const clock = { t: OCT };
    const exec = new PoolExecution(
      spec,
      {
        e2b: {
          run: async () => {
            throw new Error("boom");
          },
        },
        daytona: member({ stdout: "daytona" }, clock, 2).port,
      },
      undefined,
      store,
      () => new Date(clock.t),
    );
    expect((await exec.run("x", "/w")).stdout).toBe("daytona");
    expect(store.month(MONTH).e2b).toEqual({ used: 0, held: 0, lastFailure: "threw: boom" });
  });

  test("a command that fails on a member is the answer, not a reason to reroute", async () => {
    const { exec, daytona } = pool(storeWith(), { e2b: { code: 2, stderr: "test failed" } });
    expect((await exec.run("make check", "/w")).code).toBe(2);
    expect(daytona.calls).toEqual([]);
  });

  test("a new month starts every member at zero", () => {
    const store = storeWith({ e2b: 60 });
    expect(grant(spec.members[0]!, store.month(MONTH).e2b)).toBe(0);
    expect(grant(spec.members[0]!, store.month(monthKey(new Date(Date.UTC(2026, 10, 1)))).e2b)).toBe(60);
  });

  test("two runs at once hold minutes apart, so together they stay inside the allowance", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-pool-db-"));
    const a = new SqliteUsageStore(join(dir, "machine.db"));
    const b = new SqliteUsageStore(join(dir, "machine.db"));
    const daytona = spec.members[1]!;
    const first = a.reserve(MONTH, daytona, 10)!;
    expect(first.minutes).toBe(30);
    expect(b.reserve(MONTH, daytona, 10)).toBeUndefined();
    a.settle(first, 12);
    expect(b.reserve(MONTH, daytona, 10)?.minutes).toBe(18);
    expect(a.month(MONTH).daytona).toEqual({ used: 12, held: 18 });
  });

  test("a run never settles more than it held", () => {
    const store = storeWith();
    const hold = store.reserve(MONTH, spec.members[1]!, 10)!;
    store.settle(hold, 99);
    expect(store.month(MONTH).daytona?.used).toBe(30);
  });

  test("the report shows each member's allowance, used, left and last failure", () => {
    const store = storeWith({ e2b: 12.34 });
    store.settle(store.reserve(MONTH, spec.members[1]!, 1)!, 30, "unreachable");
    expect(poolReport(spec.members, store.month(MONTH))).toEqual([
      { runtime: "e2b", allowance: 60, used: 12.3, left: 47.7 },
      { runtime: "daytona", allowance: 30, used: 30, left: 0, lastFailure: "unreachable" },
    ]);
  });

  test("a member is cut off when it reaches the minutes it held", async () => {
    const box = startSandbox("t");
    try {
      const dir = mkdtempSync(join(tmpdir(), "factory-pool-"));
      const store = new SqliteUsageStore(":memory:");
      const started = Date.now();
      const sandbox = new HttpSandboxExecution({ kind: "http", url: box.url, tokenEnv: "T" }, { T: "t" });
      // 10 minutes held, but a minute here is 10 ms so the cut lands inside the test.
      const exec = new PoolExecution(
        { kind: "pool", members: [{ runtime: "box", minutes: 10 }] },
        { box: sandbox },
        undefined,
        store,
        () => new Date(OCT + (Date.now() - started)),
        10,
      );
      const r = await exec.run("sleep 2", dir);
      expect(r.runtimeFailed).toContain("cut off");
      expect(r.stdout).toBe("");
      expect(store.month(MONTH).box?.used).toBe(10);
    } finally {
      box.stop();
    }
  });

  test("machine.json: members are http runtimes in the same file, each once; fallback is known", () => {
    const http = { kind: "http", url: "https://sb.example/exec" };
    const one = [{ runtime: "e2b", minutes: 60 }];
    expect(runtimeProblems({ e2b: http, free: { kind: "pool", members: one } })).toEqual([]);
    expect(runtimeProblems({ e2b: http, free: { kind: "pool", members: one, fallback: "none" } })).toEqual([]);
    expect(
      runtimeProblems({
        e2b: http,
        free: {
          kind: "pool",
          members: [...one, { runtime: "e2b", minutes: 5 }, { runtime: "lwpr", minutes: 5 }],
          fallback: "nowhere",
        },
        two: { kind: "pool", members: one, fallback: "free" },
      }),
    ).toEqual([
      'runtimes.free.members: "lwpr" is not an http runtime in this file (only those stop at the allowance)',
      'runtimes.free.members: "e2b" twice',
      'runtimes.free.fallback: no runtime "nowhere" (or "none")',
      'runtimes.two.fallback: "free" is a pool',
    ]);
    expect(runtimeProblems({ free: { kind: "pool", members: [{ runtime: "x", minutes: 0 }] } })[0]).toContain(
      "expected members",
    );
  });

  test("runtimesFrom builds a pool over its members, with usage in FACTORY_HOME/machine.db", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const ports = runtimesFrom(
      {
        e2b: { kind: "http", url: "https://sb.example/exec" },
        free: { kind: "pool", members: [{ runtime: "e2b", minutes: 60 }] },
      },
      { FACTORY_HOME: home },
    );
    expect(ports.free).toBeInstanceOf(PoolExecution);
    expect(poolDbPath({ FACTORY_HOME: home })).toBe(join(home, "machine.db"));
  });
});

test("factory pool --help exits 0, and with no pool says so", async () => {
  const home = mkdtempSync(join(tmpdir(), "factory-home-"));
  const bin = join(import.meta.dir, "..", "bin", "factory");
  for (const argv of [["pool", "--help"], ["pool"]]) {
    const proc = Bun.spawn(["bun", bin, ...argv], { env: { ...process.env, FACTORY_HOME: home }, stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain(argv[1] ? "usage: factory pool" : "no pool runtime");
  }
});
