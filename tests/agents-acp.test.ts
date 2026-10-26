// The acp preset end to end: the bridge drives a fake ACP server through a whole run, refusing every
// edit in a read-only stage, and its permission, update and usage rules hold on their own.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, updateEvents, usageEvent } from "../src/agents/acp-bridge";
import { CommandExecutor } from "../src/agents/executor";
import { configProblems, mergeConfig } from "../src/config";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { processReadyIssue } from "../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

const scratch = mkdtempSync(join(tmpdir(), "factory-acp-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const FAKE = join(import.meta.dir, "fixtures/agents/fake-acp.ts");
const BRIDGE = join(import.meta.dir, "../src/agents/acp-bridge.ts");

class SkillGit extends FakeGit {
  override async ensureWorktree(cloneDir: string, worktreeDir: string, issue: number) {
    await super.ensureWorktree(cloneDir, worktreeDir, issue);
    cpSync(join(import.meta.dir, "../template/.claude/skills"), join(worktreeDir, ".claude/skills"), {
      recursive: true,
    });
  }
}

describe("acp preset", () => {
  test("a whole run ships, with every edit refused in triage, plan and verify", async () => {
    const log = mkdtempSync(join(scratch, "log-"));
    process.env.FAKE_AGENT_LOG = log;
    const issue = baseIssue(11, [LABEL.ready]);
    const github = new FakeGitHub([issue]);
    const state = new FactoryState(":memory:");
    state.setToggle("auto_approve_low_risk", true);
    const config = mergeConfig({
      repo: "acme/widgets",
      agents: { goose: { preset: "acp", command: [process.execPath, FAKE] } },
      stages: { default: "goose" },
    });
    expect(configProblems(config)).toEqual([]);
    try {
      const result = await processReadyIssue(
        issue,
        {
          github,
          git: new SkillGit(),
          state,
          executor: new CommandExecutor(config.agents, config.stages),
          gateRunner: new FakeGateRunner(),
          holdoutRunner: new FakeHoldoutRunner(),
          cloneDir: mkdtempSync(join(scratch, "clone-")),
          workspacesDir: mkdtempSync(join(scratch, "ws-")),
        },
        config,
      );
      expect(result).toBe("shipped");
    } finally {
      delete process.env.FAKE_AGENT_LOG;
    }
    expect(readFileSync(join(log, "permissions"), "utf8").trim().split("\n")).toEqual([
      "triage=reject",
      "plan=reject",
      "build=allow",
      "verify=reject",
      "pr=allow",
    ]);
    expect(github.createdPrs[0]!.body).toContain("Closes #11");
    const [row] = state.listStageRuns("acme/widgets");
    expect([row!.tokens_in, row!.tokens_out, row!.tokens_cached]).toEqual([100, 10, 40]);
    state.close();
  });

  test("an agent that exits before it answers fails the stage", async () => {
    const p = Bun.spawn([process.execPath, BRIDGE, "read", scratch, "--", process.execPath, FAKE], {
      stdin: new TextEncoder().encode("hi"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FAKE_ACP_EXIT: "1" },
    });
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toContain("exited before it answered");
  });

  test.each([
    ["new", "sneaked.txt"],
    ["covered", "notes.txt"],
  ])("a read-only stage whose agent writes without asking (%s) fails, naming %s", async (sneak, file) => {
    const ws = mkdtempSync(join(scratch, "sneak-"));
    writeFileSync(join(ws, "notes.txt"), "A");
    // Whole seconds, so the agent can put the mtime back exactly.
    utimesSync(join(ws, "notes.txt"), 1_000_000, 1_000_000);
    const p = Bun.spawn([process.execPath, BRIDGE, "read", ws, "--", process.execPath, FAKE], {
      cwd: ws,
      stdin: new TextEncoder().encode("hi"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FAKE_ACP_SNEAK: sneak, FACTORY_STAGE: "plan", FACTORY_ARTIFACT_DIR: scratch },
    });
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toContain(`a read-only stage changed ${file}`);
    expect(await new Response(p.stdout).text()).not.toContain('"kind":"result"');
  });

  test("a read-only stage allows only read kinds, and cancels when no option fits", () => {
    const options = [
      { optionId: "a", kind: "allow_always" },
      { optionId: "r", kind: "reject_once" },
    ];
    const pick = (kind: string, write: boolean, opts = options) =>
      decide({ toolCall: { kind }, options: opts }, write).result.outcome;
    expect(pick("read", false)).toEqual({ outcome: "selected", optionId: "a" });
    expect(pick("execute", false)).toEqual({ outcome: "selected", optionId: "r" });
    expect(pick("execute", true)).toEqual({ outcome: "selected", optionId: "a" });
    expect(pick("edit", false, [{ optionId: "a", kind: "allow_once" }])).toEqual({ outcome: "cancelled" });
    // The v2 form carries the tool call under subject.
    expect(decide({ subject: { toolCall: { kind: "delete" } }, options }, false).allowed).toBe(false);
  });

  test("updates become text and tool events, and usage is read only when the agent reports it", () => {
    expect(updateEvents({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } })).toEqual([
      { kind: "text", text: "hi" },
    ]);
    expect(updateEvents({ sessionUpdate: "tool_call", kind: "edit", title: "a.ts" })).toEqual([
      { kind: "tool_use", toolName: "edit", toolTarget: "a.ts" },
    ]);
    expect(updateEvents({ sessionUpdate: "plan" })).toEqual([]);
    expect(usageEvent(undefined)).toEqual({ kind: "usage", invalid: true });
    expect(usageEvent({ inputTokens: 5, outputTokens: 2 })).toEqual({
      kind: "usage",
      tokensIn: 5,
      tokensOut: 2,
      tokensCached: 0,
      total: true,
    });
  });

  test("the acp preset needs the agent's argv in command", () => {
    const problems = configProblems(
      mergeConfig({ repo: "a/b", agents: { x: { preset: "acp" } }, stages: { default: "x" } }),
    );
    expect(problems.join("\n")).toContain(`preset "acp" needs the agent's argv in "command"`);
  });
});
