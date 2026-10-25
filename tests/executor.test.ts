// Replay executor unit tests, plus the full state-machine pipeline driven
// through watch.ts with fake GitHub/git and a real in-memory FactoryState.
// No model, no network: ReplayExecutor reads fixture stream-json lines, and
// FakeGitHub/FakeGit are in-memory subclasses (GitHub/Git hold a private
// CommandRunner field, so a plain object can't structurally satisfy the
// type — subclassing and overriding every public method is the honest way
// to fake them without touching `gh` or `git`).

import { STAGE_DISALLOWED_TOOLS, STAGE_GUIDANCE, STAGE_TOOLS, stageSettings } from "../src/stage-permissions";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateStageEvents, ReplayExecutor } from "../src/executor";
import { claudeArgs, parseStreamJsonLine } from "../src/agents/presets/claude";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config";
import { runDir } from "../src/artifacts";
import { readSeal, sealKey } from "../src/receipt";
import {
  baseIssue,
  FakeGateRunner,
  FakeGit,
  FakeGitHub,
  FakeHoldoutRunner,
  fixtureFor,
  MultiStageExecutor,
} from "./harness";
import { FactoryState } from "../src/state";
import { LABEL } from "../src/labels";
import { processReadyIssue, resumeNeedsInfo } from "../src/watch";

// ---------- pure function tests ----------

describe("parseStreamJsonLine", () => {
  test("parses assistant text and tool_use blocks plus usage", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking at the issue" },
          { type: "tool_use", name: "Read" },
        ],
        usage: { input_tokens: 120, output_tokens: 40 },
      },
    });
    const events = parseStreamJsonLine(line);
    expect(events).toEqual([
      { kind: "text", text: "Looking at the issue" },
      { kind: "tool_use", toolName: "Read" },
      { kind: "usage", tokensIn: 120, tokensOut: 40 },
    ]);
  });

  test("parses a result line's cost", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.42 });
    expect(parseStreamJsonLine(line)).toEqual([{ kind: "result", costUsd: 0.42, text: "success" }]);
  });

  test("returns nothing for a blank line or unparsable JSON", () => {
    expect(parseStreamJsonLine("")).toEqual([]);
    expect(parseStreamJsonLine("not json")).toEqual([]);
  });
});

describe("aggregateStageEvents", () => {
  test("totals tool calls, tokens, and cost across events", () => {
    const result = aggregateStageEvents(
      [
        { kind: "tool_use", toolName: "Read" },
        { kind: "tool_use", toolName: "Edit" },
        { kind: "usage", tokensIn: 100, tokensOut: 20 },
        { kind: "usage", tokensIn: 50, tokensOut: 10 },
        { kind: "result", costUsd: 0.03 },
      ],
      0,
    );
    expect(result.toolCalls).toBe(2);
    expect(result.tokensIn).toBe(150);
    expect(result.tokensOut).toBe(30);
    expect(result.costUsd).toBe(0.03);
    expect(result.exitCode).toBe(0);
  });
});

describe("claudeArgs", () => {
  test("builds the exact invocation documented in executor.ts", () => {
    const args = claudeArgs({ stage: "build", issue: 7, cwd: "/tmp/x", maxBudgetUsd: 5 });
    expect(args).toEqual([
      "-p",
      "/factory-build 7",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
      "--disallowedTools",
      STAGE_DISALLOWED_TOOLS.join(","),
      "--tools",
      STAGE_TOOLS.build.join(","),
      "--settings",
      stageSettings("build", 7),
      "--append-system-prompt",
      STAGE_GUIDANCE,
      "--max-budget-usd",
      "5",
    ]);
  });

  test("result events surface refused tool calls as permissionDenials", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.1,
      permission_denials: [{ tool_name: "Write", tool_input: { file_path: "/w/.factory/runs/issue-15/triage.json" } }],
    });
    const result = aggregateStageEvents(parseStreamJsonLine(line), 0);
    expect(result.permissionDenials).toEqual(["Write /w/.factory/runs/issue-15/triage.json"]);
  });
});

describe("ReplayExecutor", () => {
  test("aggregates a recorded fixture with no process and no network", async () => {
    const executor = ReplayExecutor.fromLines("triage", 1, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
      JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.01 }),
    ]);
    const result = await executor.runStage({ stage: "triage", issue: 1, cwd: "/tmp", maxBudgetUsd: 1 });
    expect(result.toolCalls).toBe(1);
    expect(result.costUsd).toBe(0.01);
    expect(result.exitCode).toBe(0);
  });

  test("throws for a stage/issue with no recorded fixture", async () => {
    const executor = ReplayExecutor.fromLines("triage", 1, ["{}"]);
    await expect(executor.runStage({ stage: "plan", issue: 1, cwd: "/tmp", maxBudgetUsd: 1 })).rejects.toThrow(
      /no fixture recorded/,
    );
  });
});

// ---------- full pipeline ----------

describe("full happy-path pipeline (triage -> plan -> build -> verify -> pr)", () => {
  test("ships a draft PR end to end with no model and no network", async () => {
    const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
    const issue = baseIssue(1, [LABEL.ready]);
    const github = new FakeGitHub([issue]);
    const git = new FakeGit();
    const state = new FactoryState(":memory:");
    state.setToggle("auto_approve_low_risk", true);
    const config = mergeConfig({ ...DEFAULT_CONFIG, repo: "acme/widgets" });

    const executor = new MultiStageExecutor();
    executor.push("triage", 1, fixtureFor("triage", 1), {
      "triage-comment.md": "<!-- factory:triage v1 -->\nlooks good",
      "triage.json": JSON.stringify({
        disposition: "proceed",
        type: "bug",
        risk: "low",
        done_when: "tests pass",
        files_expected: ["src/a.ts"],
        gate_level: "make check",
        confidence: 0.9,
      }),
    });
    executor.push("plan", 1, fixtureFor("plan", 1), {
      "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan body",
      "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }),
    });
    executor.push("build", 1, fixtureFor("build", 1), {
      "status-comment.md": "<!-- factory:status v1 -->\nbuilding",
      "build.json": JSON.stringify({ status: "green", gate_line: "make check: 10 pass", rounds: 1 }),
      // Planted by the build agent: verify writes no acceptance.json here, so it must not be sealed.
      "acceptance.json": JSON.stringify({ ok: true, criteria: [] }),
    });
    executor.push("verify", 1, fixtureFor("verify", 1), {
      "verdict-comment.md": "<!-- factory:verdict v1 -->\npass",
      "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }),
    });
    executor.push("pr", 1, fixtureFor("pr", 1), {
      "pr-body.md": "## Summary\nDid the thing.\nCloses #1",
    });

    const deps = {
      github,
      git,
      state,
      executor,
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      cloneDir,
      workspacesDir,
    };
    const outcome = await processReadyIssue(issue, deps, config);

    expect(outcome).toBe("shipped");
    expect(github.createdPrs).toHaveLength(1);
    expect(github.createdPrs[0]!.draft).toBe(true);
    expect(github.createdPrs[0]!.body).toContain("Closes #1");
    // The fake worktree has no git, so the receipt cannot be built, and the body says so rather than go quiet.
    expect(github.createdPrs[0]!.body).toContain("## Receipt\n\nNo receipt: receipt: git rev-parse HEAD failed");
    expect(git.pushed).toEqual([1]);
    expect(readSeal(state.getSetting(sealKey("acme/widgets", 1)))?.files["acceptance.json"]).toBeNull();

    const run = state.getRun("acme/widgets", 1)!;
    expect(run.status).toBe("shipped");
    expect(run.pr_url).toBe(github.prs[0]!.url);

    const finalLabels = issue.labels.map((l) => l.name);
    expect(finalLabels).toContain(LABEL.inReview);
    expect(finalLabels).not.toContain(LABEL.ready);

    // Build's status comment is posted once and its id remembered, not
    // reposted as a fresh comment on every stage.
    expect(run.status_comment_id).toBeDefined();
    expect(issue.comments.filter((c) => c.body.includes("factory:status")).length).toBe(1);

    state.close();
    rmSync(workspacesDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });
});

describe("needs-info path", () => {
  test("posts a question, stops the loop, and resumes on a trusted reply", async () => {
    const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
    const issue = baseIssue(2, [LABEL.ready]);
    const github = new FakeGitHub([issue]);
    const git = new FakeGit();
    const state = new FactoryState(":memory:");
    const config = mergeConfig({ ...DEFAULT_CONFIG, repo: "acme/widgets" });

    const executor = new MultiStageExecutor();
    executor.push("triage", 2, fixtureFor("triage", 2), {
      "triage-comment.md": "<!-- factory:triage v1 -->\nneeds more detail",
      "triage.json": JSON.stringify({
        disposition: "needs-info",
        type: "bug",
        risk: "low",
        done_when: "",
        files_expected: [],
        gate_level: "make check",
        confidence: 0.2,
      }),
      "question-comment.md": "<!-- factory:question v1 -->\n1. Which environment?\na) staging\nb) production",
    });

    const deps = {
      github,
      git,
      state,
      executor,
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      cloneDir,
      workspacesDir,
    };
    const outcome = await processReadyIssue(issue, deps, config);

    expect(outcome).toBe("needs-info");
    expect(issue.labels.map((l) => l.name)).toContain(LABEL.needsInfo);
    expect(issue.comments.some((c) => c.body.includes("factory:question"))).toBe(true);
    expect(state.getRun("acme/widgets", 2)!.status).toBe("needs-info");

    // An untrusted reply does not resume the loop.
    issue.comments.push({
      id: 9001,
      author: "rando",
      authorAssociation: "NONE",
      body: "staging please",
      createdAt: new Date().toISOString(),
    });
    const stillWaiting = await resumeNeedsInfo(issue, deps, config);
    expect(stillWaiting).toBe("waiting");

    // A trusted reply resumes triage; simulate the resumed run's own output
    // via a second queued round for the same stage:issue key.
    await new Promise((r) => setTimeout(r, 5));
    github.roles.set("param", "admin");
    issue.comments.push({
      id: 9002,
      author: "param",
      authorAssociation: "OWNER",
      body: "staging",
      createdAt: new Date().toISOString(),
    });
    executor.push("triage", 2, fixtureFor("triage", 2), {
      "triage.json": JSON.stringify({
        disposition: "proceed",
        type: "bug",
        risk: "medium",
        done_when: "tests pass",
        files_expected: ["src/b.ts"],
        gate_level: "make check",
        confidence: 0.9,
      }),
    });
    executor.push("plan", 2, fixtureFor("plan", 2), {
      "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan body",
      "plan.json": JSON.stringify({ risk: "medium", revision: 1, files: ["src/b.ts"], autoApproveEligible: false }),
    });

    const resumed = await resumeNeedsInfo(issue, deps, config);
    expect(resumed).toBe("awaiting-approval");
    expect(issue.labels.map((l) => l.name)).toContain(LABEL.awaitingApproval);

    const worktree = join(workspacesDir, "issue-2");
    const answer = await Bun.file(join(worktree, runDir(2), "answer.md")).text();
    expect(answer).toBe("staging");

    state.close();
    rmSync(workspacesDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });
});
