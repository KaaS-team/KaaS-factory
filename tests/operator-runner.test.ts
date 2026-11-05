import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import { mergeConfig } from "../src/config";
import type { StageRunOptions, StageRunResult } from "../src/executor";
import { buildInbox } from "../src/inbox";
import { FactoryState } from "../src/state";
import { pollOnce } from "../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

const withBody = (n: number, labels: string[], body: string) => ({ ...baseIssue(n, labels), body });

class RecordingExecutor {
  starts: number[] = [];
  async runStage(opts: StageRunOptions): Promise<StageRunResult> {
    this.starts.push(opts.issue);
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

function setup(issues: ReturnType<typeof withBody>[]) {
  const root = join(tmpdir(), "factory-operator");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "ws-"));
  const executor = new RecordingExecutor();
  const deps = {
    github: new FakeGitHub(issues),
    git: new FakeGit(),
    state: new FactoryState(":memory:"),
    executor,
    gateRunner: new FakeGateRunner(),
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir: dir,
    workspacesDir: dir,
  };
  return { deps, executor, dir, config: mergeConfig({ repo: "acme/repo", concurrency: 1 }) };
}

describe("Runner: operator", () => {
  test("a ready issue marked operator is never dispatched; a factory one is", async () => {
    const { deps, config, dir, executor } = setup([
      withBody(1, ["factory:ready"], "Runner: operator\n\n## Why\nx\n"),
      withBody(2, ["factory:ready"], "Runner: factory\n\n## Why\nx\n"),
    ]);
    try {
      await pollOnce(deps, config);
      expect(executor.starts).toEqual([2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("it appears in the inbox as an item that needs the operator", () => {
    const items = buildInbox([
      withBody(1, ["factory:ready"], "Runner: operator\n\n## Why\nx\n"),
      withBody(2, ["factory:ready"], "## Why\nx\n"),
    ]);
    expect(items.map((i) => [i.issue, i.kind])).toEqual([[1, "operator"]]);
  });
});
