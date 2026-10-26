// Item 5's tests prove the machine-wide lease never oversubscribes. This
// proves the other half of item 6: pollOnce's own `inFlight` set stops two
// overlapping polls (what startWatch now runs, since it no longer awaits one
// poll's whole batch before firing the next) from dispatching the same issue
// twice at once, and a slot that frees up mid-batch can pick up a *newly*
// surfaced issue without waiting for the first poll's batch to finish.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import { mergeConfig } from "../src/config";
import type { StageRunOptions, StageRunResult } from "../src/executor";
import { FactoryState } from "../src/state";
import { pollOnce } from "../src/watch";
import type { GhIssue } from "../src/github";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

// Every stage run ends the issue at "needs-info" after triage alone, same
// shape as machine-dispatch.test.ts's fixture. `active` tracks, per issue
// number, whether a run for it is currently in flight; `concurrentDup` is set
// true the instant the same issue number is found running twice at once —
// direct instrumentation of the real call path, not a proxy that a broken
// `inFlight` check could bypass unnoticed.
class SlowTriageExecutor {
  active = new Set<number>();
  concurrentDup = false;
  starts: number[] = [];

  // A function so different issues can take deliberately different times
  // (e.g. issue #1 slow, #2 fast), which is what lets a test observe one
  // still running while another, dispatched later, has already finished.
  constructor(private readonly delayMsFor: (issue: number) => number) {}

  async runStage(opts: StageRunOptions): Promise<StageRunResult> {
    const n = opts.issue;
    if (this.active.has(n)) this.concurrentDup = true;
    this.active.add(n);
    this.starts.push(n);
    await Bun.sleep(this.delayMsFor(n));
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
    this.active.delete(n);
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

function setup(delayMsFor: (issue: number) => number) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
  const github = new FakeGitHub([baseIssue(1, ["factory:ready"])]);
  const executor = new SlowTriageExecutor(delayMsFor);
  const config = mergeConfig({ repo: "acme/repo", concurrency: 1 });
  const deps = {
    github,
    git: new FakeGit(),
    state: new FactoryState(":memory:"),
    executor,
    gateRunner: new FakeGateRunner(),
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir,
    workspacesDir,
  };
  return { deps, config, github, executor, workspacesDir, cloneDir };
}

describe("pollOnce's inFlight set makes overlapping polls (what startWatch now runs) safe", () => {
  test("a second, overlapping poll never redispatches an issue the first poll is still running", async () => {
    const { deps, config, executor, workspacesDir, cloneDir } = setup(() => 30);
    const inFlight = new Set<number>();

    // Fired back to back, with no await between them: `dispatch()` relabels
    // the issue away from "ready" before its slow stage run, so a real gap
    // here would let that relabel alone close the race and the test would
    // pass whether or not `inFlight` does anything. Only a same-tick start
    // puts both polls' own `listIssuesByLabel` calls before either one's
    // relabel resolves, so `inFlight` (set synchronously, no await) is the
    // only thing left that can close it.
    const first = pollOnce(deps, config, inFlight);
    const second = pollOnce(deps, config, inFlight);
    await Promise.all([first, second]);

    expect(executor.concurrentDup).toBe(false);
    expect(executor.starts).toEqual([1]); // the second poll saw #1 already in flight and skipped it
    expect(inFlight.size).toBe(0); // bookkeeping is cleared once each poll's batch finishes

    rmSync(workspacesDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });

  test("a newly-surfaced issue is picked up by an overlapping poll without waiting for an earlier poll's batch to finish", async () => {
    // #1 is deliberately much slower than #2, so #2's dispatch (started by
    // the later, overlapping poll) can finish while #1's is still running.
    const { deps, config, github, executor, workspacesDir, cloneDir } = setup((n) => (n === 1 ? 200 : 10));
    const inFlight = new Set<number>();

    const first = pollOnce(deps, config, inFlight); // dispatches #1, takes 200ms
    await Bun.sleep(5);
    github.issues.set(2, baseIssue(2, ["factory:ready"])); // surfaces mid-batch
    const second = pollOnce(deps, config, inFlight); // must not wait on `first`

    await second;
    // #2 was picked up and #1 was still running: proves the second poll did
    // not block on the first poll's still-in-flight batch.
    expect(executor.active.has(1)).toBe(true);
    expect(executor.starts).toContain(2);

    await first;
    expect(executor.concurrentDup).toBe(false);

    rmSync(workspacesDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });

  test("an issue that parks mid-batch is released at once, not when its batch's slowest issue finishes", async () => {
    // kaas-suite cards 34 and 36 planned in one batch with card 35, parked at
    // awaiting-approval, and sat approved until card 35's build and verify ended.
    const { deps, github, executor, workspacesDir, cloneDir } = setup((n) => (n === 1 ? 2000 : 10));
    github.issues.set(2, baseIssue(2, ["factory:ready"]));
    const config = mergeConfig({ repo: "acme/repo", concurrency: 2 });
    const inFlight = new Set<number>();

    const batch = pollOnce(deps, config, inFlight); // #1 and #2 in one batch
    // Waits on #2 parking, not a fixed sleep, which a loaded machine outran.
    for (let t = 0; t < 1800 && !(executor.starts.includes(2) && !inFlight.has(2)); t += 10) await Bun.sleep(10);
    expect(executor.active.has(1)).toBe(true);
    expect([...inFlight]).toEqual([1]);

    await batch;
    expect(inFlight.size).toBe(0);
    rmSync(workspacesDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });

  test("a poll whose issue list predates an issue's release does not redispatch it from that stale list", async () => {
    // The second poll lists #1 as ready while the first is running it, and its
    // list comes back only after #1 has parked and left inFlight.
    class StaleGitHub extends FakeGitHub {
      override async listIssuesByLabel(repo: string, label: string): Promise<GhIssue[]> {
        const snapshot = await super.listIssuesByLabel(repo, label);
        await Bun.sleep(80);
        return snapshot;
      }
    }
    const { deps, config, executor, workspacesDir, cloneDir } = setup(() => 10);
    const stale = { ...deps, github: new StaleGitHub([baseIssue(1, ["factory:ready"])]) };
    const inFlight = new Set<number>();

    const first = pollOnce(deps, config, inFlight);
    const second = pollOnce(stale, config, inFlight);
    await Promise.all([first, second]);

    expect(executor.starts).toEqual([1]);
    rmSync(workspacesDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });
});
