// An approved plan waits while an issue already building, verifying or in review names any of its
// files, and starts once that issue merges. Two plans in one poll must not both start.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import { mergeConfig } from "../src/config";
import type { StageRunOptions, StageRunResult } from "../src/executor";
import type { GhComment, GhIssue } from "../src/github";
import type { Workflow } from "../src/core/workflow";
import { parseWorkflowText } from "../src/engine/workflows";
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

// An issue awaiting approval whose plan names `files`, and (unless `approve` is false) a maintainer's approve.
function approvedIssue(n: number, files: string[], approve = true): GhIssue {
  const plan = `<!-- factory:plan v1 rev=1 -->\nPlan ${n}\n\n<!-- factory:data ${JSON.stringify({ stage: "plan", json: { files } })} -->`;
  const comments: GhComment[] = [
    { id: n * 10 + 1, author: "factory-bot", authorAssociation: "OWNER", body: plan, createdAt: nextIso() },
    { id: n * 10 + 2, author: "human", authorAssociation: "OWNER", body: "/factory approve", createdAt: nextIso() },
  ].slice(0, approve ? 2 : 1);
  return { ...baseIssue(n, [LABEL.awaitingApproval]), comments };
}

interface Opts {
  readonly setup?: string[];
  readonly now?: () => Date;
  readonly workflow?: Workflow;
}

function setup(issues: GhIssue[], opts: Opts = {}) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
  const github = new FakeGitHub(issues);
  github.roles.set("factory-bot", "admin");
  const executor = new BuildExecutor();
  const config = mergeConfig({ repo: "acme/repo", concurrency: 2, ...(opts.setup && { setup: opts.setup }) });
  const deps = {
    github,
    git: new FakeGit(),
    state: new FactoryState(":memory:"),
    executor,
    gateRunner: new FakeGateRunner(),
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir,
    workspacesDir,
    ...(opts.now && { now: opts.now }),
    ...(opts.workflow && { workflow: opts.workflow }),
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

  test("a failed worktree setup leaves no building label behind to hold other issues", async () => {
    const { deps, config, github, executor, cleanup } = setup([approvedIssue(1, ["src/a.ts"])], {
      setup: ["false"],
    });

    await pollOnce(deps, config);
    expect(executor.starts).toEqual([]);
    expect(labelsOf(github, 1)).toEqual([LABEL.needsHuman]);

    cleanup();
  });

  test("a held plan whose window lapsed says it approved itself only when it starts", async () => {
    const HOUR = 3_600_000;
    const bundled = join(import.meta.dir, "..", "template", ".factory", "workflows", "feature-to-pr.yml");
    const parsed = parseWorkflowText(
      readFileSync(bundled, "utf8").replace("revise: plan\n", "revise: plan\n        after: 4h\n"),
    );
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    const lapsed = approvedIssue(2, ["src/a.ts"], false);
    const notice = `<!-- factory:data ${JSON.stringify({ stage: "park-window", json: { step: "plan" } })} -->`;
    const noticeAt = nextIso();
    lapsed.comments = [
      ...lapsed.comments,
      {
        id: 29,
        author: "factory-bot",
        authorAssociation: "OWNER",
        body: `goes on by itself\n\n${notice}`,
        createdAt: noticeAt,
      },
    ];
    const building = { ...approvedIssue(1, ["src/a.ts"]), labels: [{ name: LABEL.building }] };
    const now = () => new Date(Date.parse(noticeAt) + 5 * HOUR);
    const { deps, config, github, executor, cleanup } = setup([building, lapsed], { now, workflow: parsed.workflow });
    const said = () => github.issues.get(2)!.comments.filter((c) => c.body.includes("No maintainer commented"));

    await pollOnce(deps, config);
    await pollOnce(deps, config);
    expect(said()).toHaveLength(0);
    expect(holdComments(github, 2)).toHaveLength(1);
    expect(executor.starts).toEqual([]);

    github.issues.get(1)!.labels = [];
    await pollOnce(deps, config);
    expect(said()).toHaveLength(1);
    expect(executor.starts).toEqual(["build:2"]);

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
