// The `pool` runtime (spec 10 row sandbox-pool): free sandboxes in order, each
// skipped once this month's minutes are spent, local when all are, and never
// run past an allowance.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpSandboxExecution } from "../src/adapters/http-sandbox/execution";
import { FileUsageStore, PoolExecution, type PoolSpec, type UsageStore } from "../src/adapters/pool/execution";
import { eligible, monthKey, type PoolUsage, poolReport, withRun } from "../src/core/sandbox-pool";
import type { ExecResult, ExecutionPort } from "../src/ports/execution";
import { poolUsagePath, runtimeProblems, runtimesFrom } from "../src/runtimes";
import { startSandbox } from "./fixtures/http-sandbox";

class MemoryStore implements UsageStore {
  constructor(public usage: PoolUsage = {}) {}
  read(): PoolUsage {
    return this.usage;
  }
  write(usage: PoolUsage): void {
    this.usage = usage;
  }
}

// A member that answers `result` and takes `minutes` of the fake clock.
function member(result: Partial<ExecResult>, clock: { t: number }, minutes = 1) {
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

const OCT = Date.UTC(2026, 9, 25);
const spec: PoolSpec = {
  kind: "pool",
  members: [
    { runtime: "e2b", minutes: 60 },
    { runtime: "daytona", minutes: 30 },
  ],
};

function pool(store: UsageStore, results: { e2b?: Partial<ExecResult>; daytona?: Partial<ExecResult> } = {}) {
  const clock = { t: OCT };
  const e2b = member(results.e2b ?? { stdout: "e2b" }, clock, 3);
  const daytona = member(results.daytona ?? { stdout: "daytona" }, clock, 2);
  const local = member({ stdout: "local" }, clock, 1);
  const exec = new PoolExecution(
    spec,
    { e2b: e2b.port, daytona: daytona.port },
    local.port,
    store,
    () => new Date(clock.t),
  );
  return { exec, e2b, daytona, local };
}

describe("sandbox pool", () => {
  test("the first member with minutes left runs, and its minutes are recorded", async () => {
    const store = new MemoryStore();
    const { exec, daytona, local } = pool(store);
    expect((await exec.run("make check", "/w")).stdout).toBe("e2b");
    expect(daytona.calls).toEqual([]);
    expect(local.calls).toEqual([]);
    expect(store.usage).toEqual({ "2026-10": { e2b: { minutes: 3 } } });
  });

  test("a spent member is skipped", async () => {
    const store = new MemoryStore({ "2026-10": { e2b: { minutes: 55 } } });
    const { exec, e2b } = pool(store);
    expect((await exec.run("make check", "/w")).stdout).toBe("daytona");
    expect(e2b.calls).toEqual([]);
  });

  test("every member spent falls back to local", async () => {
    const store = new MemoryStore({ "2026-10": { e2b: { minutes: 60 }, daytona: { minutes: 25 } } });
    const { exec, e2b, daytona } = pool(store);
    expect((await exec.run("make check", "/w")).stdout).toBe("local");
    expect([...e2b.calls, ...daytona.calls]).toEqual([]);
  });

  test("a runtime failure records it and moves on to the next member", async () => {
    const store = new MemoryStore();
    const { exec } = pool(store, { e2b: { code: 1, runtimeFailed: "sandbox answered 429" } });
    expect((await exec.run("make check", "/w")).stdout).toBe("daytona");
    expect(store.usage["2026-10"]?.e2b).toEqual({ minutes: 3, lastFailure: "sandbox answered 429" });
  });

  test("a command that fails on a member is the answer, not a reason to reroute", async () => {
    const store = new MemoryStore();
    const { exec, daytona } = pool(store, { e2b: { code: 2, stderr: "test failed" } });
    const r = await exec.run("make check", "/w");
    expect(r.code).toBe(2);
    expect(daytona.calls).toEqual([]);
  });

  test("a new month starts every member at zero", () => {
    const usage = { "2026-10": { e2b: { minutes: 60 }, daytona: { minutes: 30 } } };
    expect(eligible(spec.members, usage, "2026-10")).toEqual([]);
    expect(eligible(spec.members, usage, monthKey(new Date(Date.UTC(2026, 10, 1))))).toEqual([...spec.members]);
  });

  test("the report shows each member's allowance, used, left and last failure", () => {
    const usage = withRun(withRun({}, "2026-10", "e2b", 12.34), "2026-10", "daytona", 30, "unreachable");
    expect(poolReport(spec.members, usage, "2026-10")).toEqual([
      { runtime: "e2b", allowance: 60, used: 12.3, left: 47.7 },
      { runtime: "daytona", allowance: 30, used: 30, left: 0, lastFailure: "unreachable" },
    ]);
  });

  test("a member is cut off when it reaches the minutes it had left", async () => {
    const box = startSandbox("t");
    try {
      const dir = mkdtempSync(join(tmpdir(), "factory-pool-"));
      const store = new MemoryStore();
      const started = Date.now();
      const sandbox = new HttpSandboxExecution({ kind: "http", url: box.url, tokenEnv: "T" }, { T: "t" });
      // 10 minutes left, but a minute here is 10 ms so the cut lands inside the test.
      const exec = new PoolExecution(
        { kind: "pool", members: [{ runtime: "box", minutes: 10 }] },
        { box: sandbox },
        { run: async () => ({ stdout: "local", stderr: "", code: 0 }) },
        store,
        () => new Date(OCT + (Date.now() - started)),
        10,
      );
      const r = await exec.run("sleep 2", dir);
      expect(r.runtimeFailed).toContain("cut off");
      expect(r.stdout).toBe("");
      expect(store.usage["2026-10"]?.box?.minutes).toBe(10);
    } finally {
      box.stop();
    }
  });

  test("machine.json: members must be http runtimes in the same file, each once", () => {
    const http = { kind: "http", url: "https://sb.example/exec" };
    expect(runtimeProblems({ e2b: http, free: { kind: "pool", members: [{ runtime: "e2b", minutes: 60 }] } })).toEqual(
      [],
    );
    expect(
      runtimeProblems({
        e2b: http,
        free: {
          kind: "pool",
          members: [
            { runtime: "e2b", minutes: 60 },
            { runtime: "e2b", minutes: 5 },
            { runtime: "lwpr", minutes: 5 },
          ],
        },
      }),
    ).toEqual([
      'runtimes.free.members: "lwpr" is not an http runtime in this file (only those stop at the allowance)',
      'runtimes.free.members: "e2b" twice',
    ]);
    expect(runtimeProblems({ free: { kind: "pool", members: [{ runtime: "x", minutes: 0 }] } })[0]).toContain(
      "expected members",
    );
  });

  test("runtimesFrom builds a pool over its members, with usage under FACTORY_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const ports = runtimesFrom(
      {
        e2b: { kind: "http", url: "https://sb.example/exec" },
        free: { kind: "pool", members: [{ runtime: "e2b", minutes: 60 }] },
      },
      { FACTORY_HOME: home },
    );
    expect(ports.free).toBeInstanceOf(PoolExecution);
    expect(poolUsagePath({ FACTORY_HOME: home })).toBe(join(home, "pool-usage.json"));
    writeFileSync(poolUsagePath({ FACTORY_HOME: home }), JSON.stringify({ "2026-10": { e2b: { minutes: 1 } } }));
    expect(new FileUsageStore(poolUsagePath({ FACTORY_HOME: home })).read()).toEqual({
      "2026-10": { e2b: { minutes: 1 } },
    });
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
