// The three nightly metrics against their bars (scripts/metrics.ts).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The per-run temp parent can be gone on a rerun, so it is recreated before each mkdtemp.
const scratch = (prefix: string) => {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), prefix));
};

const script = join(import.meta.dir, "../scripts/metrics.ts");

// n finished runs; plan, build and verify cost the given dollars; `rejects` verify stages say reject.
function fixture(n: number, o: { plan: number; build: number; shipped: number; rejects: number }): string {
  const lines: object[] = [];
  for (let i = 1; i <= n; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    lines.push({
      v: 1,
      type: "run",
      repo: "o/r",
      issue: i,
      status: i <= o.shipped ? "shipped" : "failed",
      started_at: at,
    });
    for (const [stage, cost] of [
      ["plan", o.plan],
      ["build", o.build],
      ["verify", 0],
    ] as const)
      lines.push({
        v: 1,
        type: "stage",
        repo: "o/r",
        issue: i,
        stage,
        cost_usd: cost,
        started_at: at,
        verdict: stage === "verify" && i <= o.rejects ? "reject" : null,
      });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

function check(jsonl: string) {
  const dir = scratch("factory-metrics-");
  try {
    writeFileSync(join(dir, "export.jsonl"), jsonl);
    const p = Bun.spawnSync(["bun", script, join(dir, "export.jsonl"), "--check"]);
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("metrics", () => {
  test("a fixture over the bars fails --check naming the metric", () => {
    const r = check(fixture(20, { plan: 1, build: 0.2, shipped: 20, rejects: 20 }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("planShare");
    expect(r.out).toContain("rejectsPerRun");
  });
  test("costPerShipped over its bar fails on its own", () => {
    const r = check(fixture(20, { plan: 0.1, build: 2, shipped: 20, rejects: 0 }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("costPerShipped 2.10");
    expect(r.out).not.toContain("planShare 0");
  });
  test("a fixture under the bars passes", () => {
    const r = check(fixture(20, { plan: 0.1, build: 0.5, shipped: 20, rejects: 2 }));
    expect(r.code).toBe(0);
  });
  test("19 runs exit 0 with the count", () => {
    const r = check(fixture(19, { plan: 1, build: 0.2, shipped: 0, rejects: 19 }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("19 finished runs");
  });
});
