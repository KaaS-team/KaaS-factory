import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import { takeLocks } from "../src/area-locks";
import { mergeConfig } from "../src/config";
import type { StageRunOptions, StageRunResult } from "../src/executor";
import { FactoryState } from "../src/state";
import { pollOnce } from "../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

const withFiles = (n: number, labels: string[], files: string[]) => ({
  ...baseIssue(n, labels),
  body: `## Why\nx\n\n## Files\n${files.map((f) => `- \`${f}\``).join("\n")}\n`,
});

describe("takeLocks", () => {
  test("a shared file holds the later issue; disjoint issues are both free", () => {
    const ready = [withFiles(2, ["factory:ready"], ["src/a.ts"]), withFiles(3, ["factory:ready"], ["src/b.ts"])];
    const held = [withFiles(1, ["factory:building"], ["src/a.ts"])];
    const r = takeLocks(ready, held);
    expect(r.free.map((i) => i.number)).toEqual([3]);
    expect(r.locked).toEqual([{ issue: 2, heldBy: 1 }]);
  });

  test("two ready issues sharing a directory pick the first only", () => {
    const ready = [withFiles(4, [], ["src/engine"]), withFiles(5, [], ["src/engine/steps.ts"])];
    const r = takeLocks(ready, []);
    expect(r.free.map((i) => i.number)).toEqual([4]);
    expect(r.locked).toEqual([{ issue: 5, heldBy: 4 }]);
  });

  test("an issue with no Files list takes no lock and is never held", () => {
    const r = takeLocks([baseIssue(6, []), baseIssue(7, [])], [withFiles(1, [], ["src/a.ts"])]);
    expect(r.free.map((i) => i.number)).toEqual([6, 7]);
  });
});

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

describe("pollOnce with a fixture queue", () => {
  function run(issues: ReturnType<typeof withFiles>[]) {
    const root = join(tmpdir(), "factory-locks");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "ws-"));
    const github = new FakeGitHub(issues);
    const executor = new RecordingExecutor();
    const deps = {
      github,
      git: new FakeGit(),
      state: new FactoryState(":memory:"),
      executor,
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      cloneDir: dir,
      workspacesDir: dir,
    };
    return { deps, executor, config: mergeConfig({ repo: "acme/repo", concurrency: 1 }), dir };
  }

  test("an issue sharing a file with a building one is not claimed; a disjoint one is", async () => {
    const { deps, config, dir, executor } = run([
      withFiles(1, ["factory:building"], ["src/a.ts"]),
      withFiles(2, ["factory:ready"], ["src/a.ts"]),
      withFiles(3, ["factory:ready"], ["src/c.ts"]),
    ]);
    try {
      await pollOnce(deps, config);
      expect(executor.starts).toEqual([3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
