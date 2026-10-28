// An approved plan waits while an issue already building, verifying or in review names any of its
// files, and starts once that issue merges. Two plans in one poll must not both start.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import { mergeConfig } from "../src/config";
import type { StageRunOptions, StageRunResult } from "../src/executor";
import type { GhComment, GhIssue } from "../src/github";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { mergedMarker, pollOnce } from "../src/watch";
import { fileHold } from "../src/file-hold";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner, nextIso } from "./harness";

// Each build ends at needs-info, so an issue stops building once its run is over. The delay keeps
// a run in flight for long enough that a batch-mate in the same poll sees it.
class BuildExecutor {
  readonly starts: string[] = [];

  async runStage(opts: StageRunOptions): Promise<StageRunResult> {
    this.starts.push(`${opts.stage}:${opts.issue}`);
    await Bun.sleep(30);
    const dir = join(opts.cwd, runDir(opts.issue));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "question-comment.md"), "<!-- factory:question v1 -->\nWhich one?");
    writeFileSync(join(dir, "build.json"), JSON.stringify({ status: "needs-info" }));
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

// An issue awaiting approval whose plan names `files`, and a maintainer's approve after it.
function approvedIssue(n: number, files: string[]): GhIssue {
  const plan = `<!-- factory:plan v1 rev=1 -->\nPlan ${n}\n\n<!-- factory:data ${JSON.stringify({ stage: "plan", json: { files } })} -->`;
  const comments: GhComment[] = [
    { id: n * 10 + 1, author: "factory-bot", authorAssociation: "OWNER", body: plan, createdAt: nextIso() },
    { id: n * 10 + 2, author: "human", authorAssociation: "OWNER", body: "/factory approve", createdAt: nextIso() },
  ];
  return { ...baseIssue(n, [LABEL.awaitingApproval]), comments };
}

function setup(issues: GhIssue[]) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
  const github = new FakeGitHub(issues);
  github.roles.set("factory-bot", "admin");
  const executor = new BuildExecutor();
  const config = mergeConfig({ repo: "acme/repo", concurrency: 2 });
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
  const cleanup = () => {
    rmSync(workspacesDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  };
  return { deps, config, github, executor, cleanup };
}

const labelsOf = (github: FakeGitHub, n: number) => github.issues.get(n)!.labels.map((l) => l.name);
const holdComments = (github: FakeGitHub, n: number) =>
  github.issues.get(n)!.comments.filter((c) => c.body.includes("<!-- factory:hold v1 for=#"));

describe("file hold: an approved plan waits for an issue that already names its files", () => {
  test("two plans sharing a file start only the first, then the second after the first merges", async () => {
    const { deps, config, github, executor, cleanup } = setup([
      approvedIssue(1, ["src/watch.ts", "tests/a.ts"]),
      approvedIssue(2, ["src/watch.ts"]),
    ]);

    await pollOnce(deps, config);
    expect(executor.starts).toEqual(["build:1"]);
    expect(labelsOf(github, 2)).toEqual([LABEL.awaitingApproval]);
    expect(holdComments(github, 2).map((c) => c.body)).toEqual([
      expect.stringContaining("waits for #1, same files: src/watch.ts"),
    ]);

    // #1's PR is open, so it still holds the files: a later poll posts nothing new and starts nothing.
    const first = github.issues.get(1)!;
    first.labels = [{ name: LABEL.inReview }];
    await pollOnce(deps, config);
    expect(holdComments(github, 2)).toHaveLength(1);
    expect(executor.starts).toEqual(["build:1"]);

    // #1 merges: its lifecycle labels go and its merged marker is posted.
    first.labels = [];
    first.comments = [
      ...first.comments,
      {
        id: 9001,
        author: "factory-bot",
        authorAssociation: "OWNER",
        body: `merged\n\n${mergedMarker(7)}`,
        createdAt: nextIso(),
      },
    ];
    await pollOnce(deps, config);
    expect(executor.starts).toEqual(["build:1", "build:2"]);

    cleanup();
  });

  test("two disjoint plans both start in the same poll", async () => {
    const { deps, config, executor, cleanup } = setup([approvedIssue(1, ["src/a.ts"]), approvedIssue(2, ["src/b.ts"])]);

    await pollOnce(deps, config);
    expect([...executor.starts].sort()).toEqual(["build:1", "build:2"]);

    cleanup();
  });

  test("fileHold names the lowest-numbered overlap and the exact shared paths", () => {
    const active = [
      { number: 9, files: ["src/x.ts", "src/y.ts"] },
      { number: 4, files: ["src/y.ts", "src/y.ts"] },
    ];
    expect(fileHold(["src/y.ts", "src/x.ts", "src/z.ts"], active)).toEqual({ number: 4, shared: ["src/y.ts"] });
    expect(fileHold(["src/watch"], active)).toBeUndefined();
    expect(fileHold(["src/y.ts"], [])).toBeUndefined();
  });
});
