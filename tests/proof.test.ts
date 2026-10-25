// The runner's revert-and-restore proof (src/proof.ts), on a real git repo with an origin, so
// the restore is proven on git itself: the worktree ends byte-identical to HEAD every time.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import { mergeConfig } from "../src/config";
import type { StageName } from "../src/executor";
import { LABEL } from "../src/labels";
import { isTestPath, runProof, ShellProofGit, type ProofGit } from "../src/proof";
import { FactoryState } from "../src/state";
import { advanceIssue } from "../src/watch";
import {
  baseIssue,
  FakeGateRunner,
  FakeGit,
  FakeGitHub,
  FakeHoldoutRunner,
  fixtureFor,
  MultiStageExecutor,
} from "./harness";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[], cwd: string): string {
  const r = Bun.spawnSync(args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
}

function write(dir: string, path: string, body: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), body);
}

// A repo whose `test` passes only when src/add.ts returns the sum. Base has a wrong add.
function repo(): string {
  const origin = mkdtempSync(join(tmpdir(), "proof-origin-"));
  const work = mkdtempSync(join(tmpdir(), "proof-work-"));
  dirs.push(origin, work);
  run(["git", "init", "-q", "--bare", "-b", "main"], origin);
  run(["git", "init", "-q", "-b", "main"], work);
  write(work, "src/add.ts", "export const add = (a: number, b: number) => a - b;\n");
  write(work, ".factory/config.json", "{}\n");
  run(["git", "add", "-A"], work);
  run(["git", "commit", "-q", "-m", "base"], work);
  run(["git", "remote", "add", "origin", origin], work);
  run(["git", "push", "-q", "origin", "main"], work);
  run(["git", "checkout", "-q", "-b", "factory/issue-1"], work);
  return work;
}

function commit(work: string): void {
  run(["git", "add", "-A"], work);
  run(["git", "commit", "-q", "-m", "build"], work);
}

const TEST_CMD = `grep -q "a + b" src/add.ts && echo "1 pass" || { echo "expected 3, received -1"; exit 1; }`;
const git = new ShellProofGit();

describe("runProof", () => {
  test("bites: the test fails with the implementation reverted, and HEAD comes back exactly", async () => {
    const work = repo();
    write(work, "src/add.ts", "export const add = (a: number, b: number) => a + b;\n");
    write(work, "src/extra.ts", "export const x = 1;\n");
    write(work, "tests/add.test.ts", "// asserts add(1, 2) is 3\n");
    commit(work);
    const head = run(["git", "rev-parse", "HEAD^{tree}"], work);
    const r = await runProof(git, work, "main", "test", TEST_CMD);
    expect(r.status).toBe("bites");
    expect(r.tests).toEqual(["tests/add.test.ts"]);
    expect(r.reverted.sort()).toEqual(["src/add.ts", "src/extra.ts"]);
    expect(r.tail).toContain("expected 3");
    expect(readFileSync(join(work, "src/add.ts"), "utf8")).toContain("a + b");
    expect(existsSync(join(work, "src/extra.ts"))).toBe(true);
    expect(run(["git", "status", "--porcelain"], work)).toBe("");
    expect(run(["git", "rev-parse", "HEAD^{tree}"], work)).toBe(head);
  });

  test("passes-without: a test that passes on the base code proves nothing", async () => {
    const work = repo();
    write(work, "src/add.ts", "export const add = (a: number, b: number) => a + b;\n");
    write(work, "tests/add.test.ts", "// asserts nothing\n");
    commit(work);
    const r = await runProof(git, work, "main", "test", "true");
    expect(r.status).toBe("passes-without");
    expect(run(["git", "status", "--porcelain"], work)).toBe("");
  });

  test("no-tests, skipped for proof:check, unavailable without a test gate; none runs the command", async () => {
    const work = repo();
    write(work, "src/add.ts", "export const add = (a: number, b: number) => a + b;\n");
    commit(work);
    expect((await runProof(git, work, "main", "test", "exit 7")).status).toBe("no-tests");
    expect((await runProof(git, work, "main", "check", "exit 7")).status).toBe("skipped");
    expect((await runProof(git, work, "main", undefined, undefined)).status).toBe("unavailable");
  });

  test("the factory's own files are never reverted", async () => {
    const work = repo();
    write(work, "src/add.ts", "export const add = (a: number, b: number) => a + b;\n");
    write(work, ".factory/config.json", '{"changed": true}\n');
    write(work, "tests/add.test.ts", "//\n");
    commit(work);
    const r = await runProof(git, work, "main", "test", `grep -q changed .factory/config.json && ${TEST_CMD}`);
    expect(r.reverted).toEqual(["src/add.ts"]);
    expect(r.status).toBe("bites");
    expect(r.tail).toContain("expected 3");
  });
});

test("isTestPath knows the common conventions and nothing else", () => {
  for (const p of [
    "tests/a.ts",
    "src/__tests__/a.ts",
    "src/a.test.ts",
    "a.spec.tsx",
    "pkg/test_x.py",
    "x_test.go",
    "a_spec.rb",
    "spec/a.rb",
  ])
    expect(isTestPath(p)).toBe(true);
  for (const p of ["src/testing.ts", "src/contest.ts", "README.md", "src/latest/a.ts"])
    expect(isTestPath(p)).toBe(false);
});

// Wiring: watch.ts runs the proof with the plan's proof and the `test` gate, and proof.json is
// on disk when the verify session starts.
describe("watch.ts runs the proof before verify", () => {
  const stageFiles = {
    triage: {
      "triage-comment.md": "<!-- factory:triage v1 -->\nt",
      "triage.json": JSON.stringify({
        disposition: "proceed",
        type: "bug",
        risk: "low",
        done_when: "x",
        files_expected: ["src/a.ts"],
        gate_level: "make check",
        confidence: 0.9,
      }),
    },
    plan: {
      "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\np",
      "plan.json": JSON.stringify({
        risk: "low",
        revision: 1,
        files: ["src/a.ts"],
        autoApproveEligible: true,
        proof: "test",
      }),
    },
    build: {
      "status-comment.md": "<!-- factory:status v1 -->\nb",
      "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
    },
    verify: {
      "verdict-comment.md": "<!-- factory:verdict v1 -->\nv",
      "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }),
    },
    pr: { "pr-body.md": "Did it.\nCloses #1" },
  } as const;

  test("proof.json carries the result the verify stage reads", async () => {
    const workspacesDir = mkdtempSync(join(tmpdir(), "proof-ws-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "proof-clone-"));
    dirs.push(workspacesDir, cloneDir);
    const github = new FakeGitHub([baseIssue(1, [LABEL.ready])]);
    const inner = new MultiStageExecutor();
    let seen: unknown;
    const executor = {
      async runStage(opts: { stage: StageName; issue: number; cwd: string; maxBudgetUsd: number }) {
        if (opts.stage === "verify") seen = JSON.parse(readFileSync(join(opts.cwd, runDir(1), "proof.json"), "utf8"));
        return inner.runStage(opts);
      },
    };
    const calls: string[] = [];
    const proofGit: ProofGit = {
      async changes() {
        return [
          { status: "M", path: "src/a.ts" },
          { status: "A", path: "tests/a.test.ts" },
        ];
      },
      async restoreFromBase(_w, _b, paths) {
        calls.push(`restore ${paths.join(",")}`);
      },
      async remove() {},
      async restoreHead() {
        calls.push("head");
      },
      async dirty() {
        return [];
      },
      async test(_w, cmd) {
        calls.push(`test ${cmd}`);
        return { stdout: "expected 3, received -1", stderr: "", code: 1 };
      },
    };
    const state = new FactoryState(":memory:");
    state.setToggle("auto_approve_low_risk", true);
    const config = mergeConfig({ repo: "acme/widgets", gates: [{ name: "test", cmd: "make test", required: true }] });
    const deps = {
      github,
      git: new FakeGit(),
      state,
      executor,
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      proofGit,
      cloneDir,
      workspacesDir,
    };
    for (const stage of ["triage", "plan", "build", "verify", "pr"] as const)
      inner.push(stage, 1, fixtureFor(stage, 1), stageFiles[stage]);
    expect(await advanceIssue(deps, config, github.issues.get(1)!)).toBe("shipped");
    expect(calls).toEqual(["restore src/a.ts", "test make test", "head"]);
    expect(seen).toMatchObject({
      status: "bites",
      tests: ["tests/a.test.ts"],
      reverted: ["src/a.ts"],
      cmd: "make test",
    });
    expect(github.createdPrs[0]!.body).toContain("Proof: the new test fails without the change.");
  });
});
