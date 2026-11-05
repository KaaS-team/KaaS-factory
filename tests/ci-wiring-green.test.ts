// A check is wired only if it passes on the current tree (#348). Each tests/ci-wiring entry carries `onMain`,
// a command this test runs and that must exit 0, or `onMainExempt`, the reason none can run here. A new
// check wired while red turns this test red in the change that wires it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TABLE = "tests/ci-wiring";
type Entry = { onMain?: string; onMainExempt?: string };
type Run = (cmd: string) => { code: number; out: string };

const shell: Run = (cmd) => {
  const p = Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", timeout: 90_000 });
  return { code: p.exitCode ?? 1, out: `${p.stdout}${p.stderr}`.trim() };
};

export function problemsOf(name: string, entry: Entry, run: Run): string[] {
  if (entry.onMain && entry.onMainExempt) return [`${name}: set onMain or onMainExempt, not both`];
  if (entry.onMainExempt !== undefined)
    return entry.onMainExempt.trim().length >= 10 ? [] : [`${name}: onMainExempt needs a reason`];
  if (!entry.onMain) return [`${name}: no onMain command proves the check passes on the current tree`];
  const r = run(entry.onMain);
  return r.code === 0
    ? []
    : [`${name}: \`${entry.onMain}\` exits ${r.code} on the current tree: ${r.out.slice(0, 300)}`];
}

describe("a wired check passes on the current tree", () => {
  const files = readdirSync(TABLE).filter((f) => f.endsWith(".json"));

  for (const f of files)
    test(`${f} passes on the current tree`, () => {
      const entry = JSON.parse(readFileSync(join(TABLE, f), "utf8")) as Entry;
      expect(problemsOf(f, entry, shell)).toEqual([]);
    });

  test("a wired check that is red is reported", () => {
    const red = problemsOf("x.json", { onMain: "exit 3" }, shell);
    expect(red).toHaveLength(1);
    expect(red[0]).toContain("exits 3");
  });

  test("a wired check with no proof is reported", () => {
    expect(problemsOf("x.json", {}, shell)).toHaveLength(1);
    expect(problemsOf("x.json", { onMainExempt: "n/a" }, shell)).toHaveLength(1);
    expect(problemsOf("x.json", { onMain: "true", onMainExempt: "reason given here" }, shell)).toHaveLength(1);
  });

  test("a green check and a reasoned exemption pass", () => {
    expect(problemsOf("x.json", { onMain: "true" }, shell)).toEqual([]);
    expect(problemsOf("x.json", { onMainExempt: "needs the live board over the network" }, shell)).toEqual([]);
  });
});
