// The engine a workflow test drives: fake GitHub, executor, shell and git around a real
// FactoryState, with one issue and every stage's output queued. advanceIssue runs it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mergeConfig } from "../src/config";
import type { Workflow } from "../src/core/workflow";
import { LABEL } from "../src/labels";
import type { SetupRunner } from "../src/setup";
import { FactoryState } from "../src/state";
import { advanceIssue, type WatchDeps } from "../src/watch";
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
export function removeEngineDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export class FakeShell implements SetupRunner {
  readonly ran: string[] = [];
  constructor(private readonly code: number) {}
  async run(cmd: string) {
    this.ran.push(cmd);
    return { stdout: "lint says no", stderr: "", code: cmd === "make lint" ? this.code : 0 };
  }
}

// `base` is written to the clone (the base branch); `seed` to every new worktree.
export type Stage = Parameters<MultiStageExecutor["push"]>[0];
// `opts`: the issue's labels, config keys over the defaults, and each stage's outputs in run order.
export interface EngineOpts {
  readonly labels?: string[];
  readonly config?: Record<string, unknown>;
  readonly outputs?: Partial<Record<Stage, Array<Record<string, string>>>>;
}

export function engine(
  workflow: Workflow,
  lintExit: number,
  base: Record<string, string> = {},
  seed: Record<string, string> = {},
  extra: Partial<WatchDeps> = {},
  opts: EngineOpts = {},
) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
  dirs.push(workspacesDir, cloneDir);
  for (const [name, content] of Object.entries(base)) {
    mkdirSync(dirname(join(cloneDir, name)), { recursive: true });
    writeFileSync(join(cloneDir, name), content);
  }
  const github = new FakeGitHub([baseIssue(1, opts.labels ?? [LABEL.ready])]);
  const executor = new MultiStageExecutor();
  const setupRunner = new FakeShell(lintExit);
  const git = new FakeGit();
  git.seed = seed;
  const gateRunner = new FakeGateRunner();
  const deps = {
    github,
    git,
    state: new FactoryState(":memory:"),
    executor,
    gateRunner,
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir,
    workspacesDir,
    setupRunner,
    workflow,
    ...extra,
  };
  const config = mergeConfig({ repo: "acme/widgets", ...opts.config });
  const push = (stage: Stage, files: Record<string, string>) => {
    for (const out of opts.outputs?.[stage] ?? [files]) executor.push(stage, 1, fixtureFor(stage, 1), out);
  };
  push("triage", {
    "triage-comment.md": "<!-- factory:triage v1 -->\nt",
    "triage.json": JSON.stringify({
      disposition: "proceed",
      type: "bug",
      risk: "low",
      done_when: "x",
      files_expected: ["a"],
      gate_level: "x",
      confidence: 0.9,
    }),
  });
  for (const out of opts.outputs?.plan ?? []) executor.push("plan", 1, fixtureFor("plan", 1), out);
  push("build", {
    "status-comment.md": "<!-- factory:status v1 -->\nb",
    "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
  });
  push("verify", {
    "verdict-comment.md": "<!-- factory:verdict v1 -->\nv",
    "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }),
  });
  push("pr", { "pr-body.md": "Did it.\nCloses #1" });
  return {
    github,
    executor,
    setupRunner,
    gateRunner,
    deps,
    config,
    run: () => advanceIssue(deps, config, github.issues.get(1)!),
  };
}
