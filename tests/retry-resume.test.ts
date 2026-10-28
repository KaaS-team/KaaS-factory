// A retry resumes at the stage that failed. The failure comment names that stage, and
// deriveIssueState reads it back; an older failure comment with no stage still resumes at plan.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChatOps } from "../src/chatops";
import { mergeConfig } from "../src/config";
import { deriveIssueState, parseDataMarkers } from "../src/derive";
import type { StageName, StageRunResult } from "../src/executor";
import type { GhComment, GhIssue } from "../src/github";
import { LABEL } from "../src/labels";
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
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function comment(body: string, id = 1): GhComment {
  return { id, author: "factory-bot", authorAssociation: "NONE", body, createdAt: "2026-01-01T00:00:00Z" };
}

function marker(stage: string, json: unknown): string {
  return `<!-- factory:data ${JSON.stringify({ stage, json })} -->`;
}

function issueWith(labels: string[], comments: GhComment[]): GhIssue {
  return { number: 1, title: "t", body: "b", labels: labels.map((name) => ({ name })), comments };
}

describe("deriveIssueState resumes at the stage a failure names", () => {
  test("plan then a failure naming build resumes at build", () => {
    const issue = issueWith(
      [LABEL.failed],
      [
        comment(marker("plan", { risk: "low" }), 1),
        comment(marker("failure", { stage: "build", fingerprint: "build: x", inputs: "h" }), 2),
      ],
    );
    expect(deriveIssueState(issue).resumeStage).toBe("build");
  });

  test("plan then an old failure with no stage still resumes at plan", () => {
    const issue = issueWith(
      [LABEL.failed],
      [comment(marker("plan", { risk: "low" }), 1), comment(marker("failure", { fingerprint: "build: x" }), 2)],
    );
    expect(deriveIssueState(issue).resumeStage).toBe("plan");
  });

  test("a failure naming a stage that is not a step is ignored", () => {
    const issue = issueWith(
      [LABEL.failed],
      [comment(marker("plan", {}), 1), comment(marker("failure", { stage: "nonsense" }), 2)],
    );
    expect(deriveIssueState(issue).resumeStage).toBe("plan");
  });
});

describe("parseChatOps reads an optional --force and step on retry", () => {
  const parse = (body: string) => parseChatOps(body);

  test("the four forms of AC-1", () => {
    expect(parse("/factory retry")).toEqual({ type: "retry" });
    expect(parse("/factory retry --force")).toEqual({ type: "retry", force: true });
    expect(parse("/factory retry verify")).toEqual({ type: "retry", step: "verify" });
    expect(parse("/factory retry --force verify")).toEqual({ type: "retry", force: true, step: "verify" });
  });

  test("the step is lowercased", () => {
    expect(parse("/factory retry Verify")).toEqual({ type: "retry", step: "verify" });
  });
});

describe("a retry naming a step", () => {
  // The build-failure setup from the test below, stopped at the parked run.
  async function parkedAtBuild() {
    const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
    dirs.push(workspacesDir, cloneDir);
    const github = new FakeGitHub([baseIssue(1, [LABEL.ready])]);
    const state = new FactoryState(":memory:");
    const executor = new MultiStageExecutor();
    const config = mergeConfig({ repo: "acme/widgets" });
    const deps = {
      github,
      git: new FakeGit(),
      state,
      executor,
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      cloneDir,
      workspacesDir,
    };
    const step = () => advanceIssue(deps, config, github.issues.get(1)!);
    const push = (stage: StageName, files: Record<string, string>, result?: Partial<StageRunResult>) =>
      executor.push(stage, 1, fixtureFor(stage, 1), files, result);
    state.setToggle("auto_approve_low_risk", true);
    push("triage", {
      "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
      "triage.json": JSON.stringify({
        disposition: "proceed",
        type: "bug",
        risk: "low",
        done_when: "x",
        files_expected: ["src/a.ts"],
        gate_level: "make check",
        confidence: 0.9,
      }),
    });
    push("plan", {
      "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
      "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }),
    });
    push("build", {}, { exitCode: 1, killedReason: "timed out after 15 minutes" });
    expect(await step()).toBe("failed");
    return { github, state, step, push };
  }

  test("a retry naming a workflow step resumes there", async () => {
    const { github, state, step, push } = await parkedAtBuild();
    push("plan", {
      "plan-comment.md": "<!-- factory:plan v1 rev=2 -->\nplan again",
      "plan.json": JSON.stringify({ risk: "low", revision: 2, files: ["src/a.ts"], autoApproveEligible: true }),
    });
    push("build", {
      "status-comment.md": "<!-- factory:status v1 -->\nbuilding",
      "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
    });
    push("verify", {
      "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
      "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }),
    });
    push("pr", { "pr-body.md": "Did it.\nCloses #1" });
    github.say(1, "/factory retry plan");
    expect(await step()).toBe("shipped");

    expect(github.issues.get(1)!.comments.some((c) => c.body.includes("Retrying from plan."))).toBe(true);
    const stages = state.listStageRuns("acme/widgets", { issue: 1 }).map((r) => r.stage);
    expect(stages.filter((s) => s === "plan")).toHaveLength(2);
    state.close();
  });

  test("a retry naming an unknown step resumes at the derived stage", async () => {
    const { github, state, step, push } = await parkedAtBuild();
    push("build", {
      "status-comment.md": "<!-- factory:status v1 -->\nbuilding",
      "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
    });
    push("verify", {
      "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
      "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }),
    });
    push("pr", { "pr-body.md": "Did it.\nCloses #1" });
    github.say(1, "/factory retry nosuchstage");
    expect(await step()).toBe("shipped");

    expect(github.issues.get(1)!.comments.some((c) => c.body.includes("Retrying from build."))).toBe(true);
    const stages = state.listStageRuns("acme/widgets", { issue: 1 }).map((r) => r.stage);
    expect(stages.filter((s) => s === "plan")).toHaveLength(1);
    expect(stages.filter((s) => s === "build")).toHaveLength(2);
    state.close();
  });
});

describe("a build failure retried through the engine", () => {
  test("the failure comment names build, and a retry runs build again without calling plan", async () => {
    const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
    dirs.push(workspacesDir, cloneDir);
    const github = new FakeGitHub([baseIssue(1, [LABEL.ready])]);
    const state = new FactoryState(":memory:");
    const executor = new MultiStageExecutor();
    const config = mergeConfig({ repo: "acme/widgets" });
    const deps = {
      github,
      git: new FakeGit(),
      state,
      executor,
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      cloneDir,
      workspacesDir,
    };
    const step = () => advanceIssue(deps, config, github.issues.get(1)!);
    const push = (stage: StageName, files: Record<string, string>, result?: Partial<StageRunResult>) =>
      executor.push(stage, 1, fixtureFor(stage, 1), files, result);
    state.setToggle("auto_approve_low_risk", true);

    push("triage", {
      "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
      "triage.json": JSON.stringify({
        disposition: "proceed",
        type: "bug",
        risk: "low",
        done_when: "x",
        files_expected: ["src/a.ts"],
        gate_level: "make check",
        confidence: 0.9,
      }),
    });
    push("plan", {
      "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
      "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }),
    });
    // The agent is killed before it writes a status comment, so no build marker is posted.
    push("build", {}, { exitCode: 1, killedReason: "timed out after 15 minutes" });
    expect(await step()).toBe("failed");

    const failure = parseDataMarkers(github.issues.get(1)!.comments).find((m) => m.stage === "failure");
    expect(failure?.json).toMatchObject({ stage: "build" });

    push("build", {
      "status-comment.md": "<!-- factory:status v1 -->\nbuilding",
      "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
    });
    push("verify", {
      "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
      "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }),
    });
    push("pr", { "pr-body.md": "Did it.\nCloses #1" });
    github.say(1, "/factory retry");
    expect(await step()).toBe("shipped");

    const stages = state.listStageRuns("acme/widgets", { issue: 1 }).map((r) => r.stage);
    expect(stages.filter((s) => s === "plan")).toHaveLength(1);
    expect(stages.filter((s) => s === "build")).toHaveLength(2);
    state.close();
  });
});
