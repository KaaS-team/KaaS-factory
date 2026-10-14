// v2.11.0 item C: holdout tests. `runHoldout` unit tests prove the pure
// orchestration (ok/detail, truncation); the scenario tests prove watch.ts's
// wiring — holdout paths are merged into the protected-path guard, a failing
// holdout rejects and rebuilds with only the failure detail surfaced (never
// source), and it caps at MAX_VERIFY_REJECTS the same way a rejected verdict
// does, escalating to needs-human with a gave-up retro.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import type { StageName, StageRunResult } from "../src/executor";
import { runHoldout, type HoldoutRunner } from "../src/holdout";
import { FactoryState } from "../src/state";
import { LABEL } from "../src/labels";
import { advanceIssue } from "../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner, fixtureFor, MultiStageExecutor } from "./harness";

// ---------- pure function: runHoldout ----------

class FixedHoldoutRunner implements HoldoutRunner {
  constructor(private readonly result: { stdout: string; stderr: string; code: number }) {}
  async run() {
    return this.result;
  }
}

describe("runHoldout", () => {
  test("ok is true, detail is the runner's own stdout, when it exits 0", async () => {
    const result = await runHoldout(new FixedHoldoutRunner({ stdout: "3 pass", stderr: "", code: 0 }), "/tmp/w", "main", { paths: [], cmd: "true" });
    expect(result).toEqual({ ok: true, detail: "3 pass" });
  });

  test("ok is false and detail carries the failing assertion, stdout and stderr combined", async () => {
    const result = await runHoldout(
      new FixedHoldoutRunner({ stdout: "running holdout suite", stderr: "expect(total).toBe(10) received 9", code: 1 }),
      "/tmp/w",
      "main",
      { paths: [".factory/holdout/**"], cmd: "bun test" },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("expect(total).toBe(10)");
  });

  test("truncates detail to the last 2000 characters, never a full log dump", async () => {
    const long = "x".repeat(5000);
    const result = await runHoldout(new FixedHoldoutRunner({ stdout: long, stderr: "", code: 1 }), "/tmp/w", "main", { paths: [], cmd: "x" });
    expect(result.detail.length).toBe(2000);
    expect(result.detail).toBe(long.slice(-2000));
  });
});

// ---------- watch.ts wiring: reject/rebuild, cap, protected paths ----------

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup(initial: string[], overrides: Parameters<typeof mergeConfig>[0] = { repo: "acme/widgets" }, n = 1) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-holdout-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-holdout-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const github = new FakeGitHub([baseIssue(n, initial)]);
  const git = new FakeGit();
  const state = new FactoryState(":memory:");
  const executor = new MultiStageExecutor();
  const gateRunner = new FakeGateRunner();
  const holdoutRunner = new FakeHoldoutRunner();
  const config = mergeConfig({ repo: "acme/widgets", ...overrides });
  const deps = { github, git, state, executor, gateRunner, holdoutRunner, cloneDir, workspacesDir };
  const push = (stage: StageName, files: Record<string, string>, result?: Partial<StageRunResult>) => executor.push(stage, n, fixtureFor(stage, n), files, result);
  const step = () => advanceIssue(deps, config, github.issues.get(n)!);
  return { n, github, git, state, holdoutRunner, config, deps, push, step, workspacesDir };
}

const HOLDOUT_CONFIG = { paths: [".factory/holdout/**"], cmd: "bun test .factory/holdout" };
// `.factory/**` is already always-protected (ALWAYS_PROTECTED_PATHS), so a
// path under it would park regardless of the protectedPaths merge under
// test below; this path lives outside it, so only the merge itself protects it.
const OUTSIDE_HOLDOUT_CONFIG = { paths: ["holdout-tests/**"], cmd: "bun test holdout-tests" };

const triage = (o: object = {}) => ({
  "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
  "triage.json": JSON.stringify({ disposition: "proceed", type: "bug", risk: "low", done_when: "x", files_expected: ["src/a.ts"], gate_level: "make check", confidence: 0.9, ...o }),
});
const plan = () => ({
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
  "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }),
});
const build = () => ({ "status-comment.md": "<!-- factory:status v1 -->\nbuilding", "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }) });
const verdict = (result: "pass" | "reject") => ({ "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict", "verdict.json": JSON.stringify({ result, rounds: 1, findings: [] }) });
const pr = () => ({ "pr-body.md": "Did it.\nCloses #1" });
const retro = () => ({ "retro-comment.md": "<!-- factory:retro v1 -->\nnothing new", "retro.json": JSON.stringify({ outcome: "complete", summary: "nothing new" }) });

describe("holdout off (default config)", () => {
  test("the runner never runs, and a normal build still ships", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.push("triage", triage());
    c.push("plan", plan());
    c.push("build", build());
    c.push("verify", verdict("pass"));
    c.push("pr", pr());
    expect(await c.step()).toBe("shipped");
    expect(c.holdoutRunner.runs).toBe(0);
  });
});

describe("holdout on", () => {
  test("a failing holdout rejects with the failure detail (never source) and rebuilds; a passing retry ships", async () => {
    const c = setup([LABEL.ready], { repo: "acme/widgets", holdout: HOLDOUT_CONFIG });
    c.state.setToggle("auto_approve_low_risk", true);
    c.holdoutRunner.next = [false];
    c.holdoutRunner.detail = "expect(total).toBe(10)\nreceived 9";
    c.push("triage", triage());
    c.push("plan", plan());
    c.push("build", build()); // round 1: holdout fails, rejects, rebuilds
    c.push("build", build()); // round 2: holdout passes (FakeHoldoutRunner.ok default true)
    c.push("verify", verdict("pass"));
    c.push("pr", pr());

    expect(await c.step()).toBe("shipped");
    expect(c.holdoutRunner.runs).toBe(2);
    const comments = c.github.issues.get(c.n)!.comments.map((cm) => cm.body);
    expect(comments.some((b) => b.includes("Holdout tests failed") && b.includes("expect(total).toBe(10)"))).toBe(true);
    // A pass posts nothing, so the run page reads the last result from the run's own folder.
    const saved = JSON.parse(readFileSync(join(c.workspacesDir, `issue-${c.n}`, `.factory/runs/issue-${c.n}/holdout.json`), "utf8"));
    expect(saved).toMatchObject({ ok: true, cmd: HOLDOUT_CONFIG.cmd });
  });

  test("a holdout path outside .factory/** in the diff parks before any push, same as any other protected path", async () => {
    const c = setup([LABEL.ready], { repo: "acme/widgets", holdout: OUTSIDE_HOLDOUT_CONFIG });
    c.state.setToggle("auto_approve_low_risk", true);
    c.git.changed = ["holdout-tests/secret.test.ts"];
    c.push("triage", triage());
    c.push("plan", plan());
    c.push("build", build());
    expect(await c.step()).toBe("needs-human");
    expect(c.git.pushed).toEqual([]);
    expect(c.state.getRun("acme/widgets", c.n)!.reason).toContain("holdout-tests/secret.test.ts");
  });

  test("holdout failing every round caps at MAX_VERIFY_REJECTS, then needs-human with a gave-up retro", async () => {
    const c = setup([LABEL.ready], { repo: "acme/widgets", holdout: HOLDOUT_CONFIG });
    c.state.setToggle("auto_approve_low_risk", true);
    c.holdoutRunner.ok = false;
    c.holdoutRunner.detail = "expect(total).toBe(10)\nreceived 9";
    c.push("triage", triage());
    c.push("plan", plan());
    for (let i = 0; i < 3; i++) c.push("build", build());
    c.push("retro", retro());

    expect(await c.step()).toBe("needs-human");
    expect(c.state.getRun("acme/widgets", c.n)!.reason).toContain("holdout tests failed 3 times");
    expect(c.state.listRetros("acme/widgets")).toEqual([expect.objectContaining({ issue: c.n, outcome: "gave-up", status: "done" })]);
  });
});
