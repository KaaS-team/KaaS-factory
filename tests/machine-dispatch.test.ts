// The unit MachineLeases test proves the SQLite lease table itself never
// oversubscribes; this proves watch.ts's own dispatch path actually calls
// into it. Two independent WatchDeps (standing in for two watcher processes
// — splitbill-demo's and lwp-website's, say) share one MachineLeases pointed
// at the same db file. Whatever the mix of stage-run lengths, the number of
// simultaneously-running stages across both never exceeds the machine's slots.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import { mergeConfig } from "../src/config";
import type { StageRunOptions, StageRunResult } from "../src/executor";
import { FactoryState } from "../src/state";
import { pollOnce } from "../src/watch";
import { canServe, loadMachineConfig, MachineLeases, MachineSpend } from "../src/machine";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

// Every stage run this executor serves takes `delayMs` and always ends the
// issue at "needs-info" after triage alone — one runStage call is enough to
// create overlap between issues, and stopping there keeps the fixture tiny.
// `shared` is the same object across both "processes" in the test below, so
// it measures real concurrent execution directly, independent of whether the
// lease mechanism under test is the thing actually bounding it.
class SlowTriageExecutor {
  constructor(
    private readonly delayMs: number,
    private readonly shared: { active: number; max: number },
  ) {}

  async runStage(opts: StageRunOptions): Promise<StageRunResult> {
    this.shared.active += 1;
    this.shared.max = Math.max(this.shared.max, this.shared.active);
    await Bun.sleep(this.delayMs);
    const dir = join(opts.cwd, runDir(opts.issue));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "triage-comment.md"), "<!-- factory:triage v1 -->\ntriage");
    writeFileSync(
      join(dir, "triage.json"),
      JSON.stringify({
        disposition: "needs-info",
        type: "bug",
        risk: "low",
        done_when: "x",
        files_expected: ["src/a.ts"],
        gate_level: "make check",
        confidence: 0.9,
      }),
    );
    writeFileSync(join(dir, "question-comment.md"), "<!-- factory:question v1 -->\nWhich one?");
    this.shared.active -= 1;
    return {
      events: [],
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0.01,
      costReported: true,
      exitCode: 0,
      permissionDenials: [],
    };
  }
}

function makeDeps(
  repo: string,
  issues: number[],
  executor: SlowTriageExecutor,
  leases: MachineLeases,
  slots: number,
  spend: MachineSpend,
) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
  const github = new FakeGitHub(issues.map((n) => baseIssue(n, ["factory:ready"])));
  const config = mergeConfig({ repo, concurrency: issues.length });
  const deps = {
    github,
    git: new FakeGit(),
    state: new FactoryState(":memory:"),
    executor,
    gateRunner: new FakeGateRunner(),
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir,
    workspacesDir,
    machine: { leases, config: { slots }, spend },
  };
  return { deps, config, workspacesDir, cloneDir };
}

describe("pollOnce respects a machine-wide lease across two independent WatchDeps", () => {
  test("running stages never exceed the machine's slot count, whatever the mix of job lengths", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "factory-machine-"));
    const dbPath = join(dbDir, "machine.db");
    const leasesA = new MachineLeases(dbPath);
    const leasesB = new MachineLeases(dbPath);
    const spendA = new MachineSpend(dbPath);
    const spendB = new MachineSpend(dbPath);
    const slots = 2;

    // Shared across both "processes": measures real concurrent execution
    // directly, so a broken lease shows up here even if held() itself can't
    // be trusted (e.g. a break that skips acquiring a lease altogether).
    const shared = { active: 0, max: 0 };
    const execA = new SlowTriageExecutor(15, shared);
    const execB = new SlowTriageExecutor(5, shared);
    const a = makeDeps("acme/repo-a", [1, 2, 3], execA, leasesA, slots, spendA);
    const b = makeDeps("acme/repo-b", [1, 2, 3], execB, leasesB, slots, spendB);

    await Promise.all([pollOnce(a.deps, a.config), pollOnce(b.deps, b.config)]);

    expect(shared.max).toBeLessThanOrEqual(slots);
    expect(shared.max).toBeGreaterThan(0); // the run actually overlapped, not just ran serially
    expect(leasesA.held()).toBe(0); // every lease is released once its stage finishes

    leasesA.close();
    leasesB.close();
    spendA.close();
    spendB.close();
    for (const dir of [a.workspacesDir, a.cloneDir, b.workspacesDir, b.cloneDir, dbDir])
      rmSync(dir, { recursive: true, force: true });
  });
});

describe("capability routing", () => {
  test("an issue labelled needs:<cap> goes only to a machine that has it", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "factory-machine-"));
    const leases = new MachineLeases(join(dbDir, "machine.db"));
    const spend = new MachineSpend(join(dbDir, "machine.db"));
    const shared = { active: 0, max: 0 };
    const plain = makeDeps("acme/repo", [1, 2], new SlowTriageExecutor(0, shared), leases, 2, spend);
    plain.deps.github.issues.get(2)!.labels.push({ name: "needs:gpu" });
    const first = await pollOnce(plain.deps, plain.config);
    expect(first.processed).toEqual([1]);
    const gpu = makeDeps("acme/repo", [2], new SlowTriageExecutor(0, shared), leases, 2, spend);
    gpu.deps.github.issues.get(2)!.labels.push({ name: "needs:gpu" });
    const withGpu = { ...gpu.deps, machine: { ...gpu.deps.machine, config: { slots: 2, capabilities: ["gpu"] } } };
    expect((await pollOnce(withGpu, gpu.config)).processed).toEqual([2]);
    leases.close();
    spend.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  test("machine.json capabilities are lowercase names", () => {
    expect(canServe(["gpu", "macos"], [{ name: "needs:gpu" }, { name: "bug" }])).toBe(true);
    expect(canServe(undefined, [{ name: "needs:gpu" }])).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "factory-home-"));
    writeFileSync(join(dir, "machine.json"), JSON.stringify({ slots: 1, capabilities: ["gpu"] }));
    expect(loadMachineConfig({ FACTORY_HOME: dir }).capabilities).toEqual(["gpu"]);
    writeFileSync(join(dir, "machine.json"), JSON.stringify({ slots: 1, capabilities: ["GPU box"] }));
    expect(() => loadMachineConfig({ FACTORY_HOME: dir })).toThrow(/"capabilities" must be a list of lowercase names/);
    rmSync(dir, { recursive: true, force: true });
  });
});
