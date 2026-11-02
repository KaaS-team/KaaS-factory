import { describe, expect, test } from "bun:test";
import { PoolExecution, type PoolSpec, SqliteUsageStore } from "../src/adapters/pool/execution";
import { classifyLaunch, nextAction } from "../src/launch-attempt";
import type { ExecutionPort } from "../src/ports/execution";

describe("classifyLaunch", () => {
  test("one case per outcome", () => {
    expect(classifyLaunch({ exitCode: 0 })).toBe("started");
    expect(classifyLaunch({ runtimeFailed: "HTTP 429 Too Many Requests" })).toBe("rate_limited");
    expect(classifyLaunch({ runtimeFailed: "concurrency limit reached" })).toBe("concurrency_limited");
    expect(classifyLaunch({ runtimeFailed: "Sandbox not found" })).toBe("environment_gone");
    expect(classifyLaunch({ runtimeFailed: "agent exited before the first message" })).toBe("agent_gone");
    expect(classifyLaunch({ runtimeFailed: "something odd" })).toBe("stopped_unexpectedly");
  });
});

describe("nextAction", () => {
  test("rate limit delay doubles per attempt and stops at a cap", () => {
    const d = (n: number) => nextAction("rate_limited", n).delayMs as number;
    expect(nextAction("rate_limited", 1).do).toBe("requeue");
    expect(d(2)).toBe(d(1) * 2);
    expect(d(3)).toBe(d(1) * 4);
    expect(d(40)).toBe(d(41));
    expect(d(40)).toBeGreaterThan(d(1));
  });

  test("concurrency pauses the runtime and never fails", () => {
    for (const n of [1, 2, 3, 10]) expect(nextAction("concurrency_limited", n).do).toBe("pause_runtime");
  });

  test("unknown failures requeue twice and fail on the third attempt", () => {
    expect(nextAction("stopped_unexpectedly", 1).do).toBe("requeue");
    expect(nextAction("stopped_unexpectedly", 2).do).toBe("requeue");
    expect(nextAction("stopped_unexpectedly", 3).do).toBe("fail");
    expect(nextAction("started", 1).do).toBe("none");
  });
});

describe("pool fallback line", () => {
  test("carries the outcome of the member failure", async () => {
    const spec: PoolSpec = { kind: "pool", members: [{ runtime: "e2b", minutes: 60 }] };
    const broken: ExecutionPort = {
      async run() {
        return { stdout: "", stderr: "", code: 1, runtimeFailed: "HTTP 429 Too Many Requests" };
      },
    };
    const local: ExecutionPort = {
      async run() {
        return { stdout: "local", stderr: "", code: 0 };
      },
    };
    const exec = new PoolExecution(spec, { e2b: broken }, local, new SqliteUsageStore(":memory:"));
    const r = await exec.run("make check", "/w");
    expect(r.stdout).toBe("local");
    expect(r.stderr).toContain("[rate_limited]");
  });
});
