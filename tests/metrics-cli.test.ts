import { describe, expect, test } from "bun:test";
import { cmdMetrics, ledgerOf } from "../src/metrics-cli";
import type { StageRun } from "../src/state";

const stage = (issue: number, cost: number | null) => ({ issue, cost_usd: cost }) as StageRun;
const flags = (f: Record<string, string>) => ({ flag: (n: string) => f[n], has: (n: string) => n in f });

const issues = [
  { number: 1, state: "CLOSED", closedAt: "2026-10-10T00:00:00Z", labels: [{ name: "factory:ready" }], comments: [] },
  { number: 2, state: "CLOSED", closedAt: "2026-10-10T00:00:00Z", labels: [{ name: "factory:ready" }], comments: [] },
];
const prs = [
  {
    number: 5,
    state: "MERGED",
    mergedAt: "2026-10-11T00:00:00Z",
    closingIssuesReferences: [{ number: 1 }],
  },
];
const runner = {
  run: async (a: string[]) => ({ code: 0, stderr: "", stdout: JSON.stringify(a[0] === "issue" ? issues : prs) }),
};

async function run(f: Record<string, string>) {
  const lines: string[] = [];
  const log = console.log;
  console.log = (s: string) => void lines.push(s);
  try {
    await cmdMetrics(flags(f), {
      runner,
      repo: "o/r",
      defaultWorkflow: "feature-to-pr",
      stages: [stage(1, 1.5), stage(1, 0.5), stage(2, 3)],
    });
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

describe("factory metrics", () => {
  test("the ledger sums an issue's stage runs and makes one unknown cost unknown", () => {
    const l = ledgerOf([stage(1, 1), stage(1, 2), stage(2, 1), stage(2, null)]);
    expect([l.costOf(1), l.costOf(2), l.costOf(3)]).toEqual([3, null, undefined]);
  });

  test("the text report gives cost per accepted outcome per workflow and per team", async () => {
    const out = await run({});
    expect(out).toContain("feature-to-pr  accepted 2, not kept 0, cost per accepted outcome $2.50");
    expect(out).toContain("(none)  accepted 2");
  });

  test("--json carries the same report and --since drops earlier outcomes", async () => {
    const all = JSON.parse(await run({ json: "" })).data;
    expect(all.workflows[0].costPerAccepted).toBe(2.5);
    const later = JSON.parse(await run({ json: "", since: "2026-10-11T00:00:00Z" })).data;
    expect(later.workflows[0].accepted).toBe(1);
    expect(later.workflows[0].costPerAccepted).toBe(2);
  });

  test("a date that is not a date is refused", async () => {
    await expect(run({ since: "last week" })).rejects.toThrow("not a date");
  });
});
