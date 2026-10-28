// Takeover and the live view, against a real child process: the transcript
// grows while the agent runs, the live file names its pid while it runs and is
// gone after, and the takeover marker turns a SIGTERM into "operator takeover".

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import { parseStreamJsonLine } from "../src/agents/presets/claude";
import { OPERATOR_TAKEOVER } from "../src/executor";
import { livePath, takeoverMarker, transcriptPath } from "../src/paths";
import { renderRunSummary } from "../src/run-summary";
import { FactoryState, type StageRun } from "../src/state";
import { readLive, resumeArgv, stopRunningStage, takeoverBanner } from "../src/takeover";
import { defaultFixtureDir } from "../src/verify-agent";

const scratch = mkdtempSync(join(tmpdir(), "factory-takeover-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}

// A FACTORY_HOME that is also a worktree with the build skill, which a command agent's prompt is rendered from.
function home(): string {
  const dir = mkdtempSync(join(scratch, "home-"));
  mkdirSync(join(dir, ".claude/skills/factory-build"), { recursive: true });
  writeFileSync(join(dir, ".claude/skills/factory-build/SKILL.md"), "build it\n");
  return dir;
}

function agent(body: string): CommandExecutor {
  const script = join(mkdtempSync(join(scratch, "bin-")), "agent.sh");
  writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return new CommandExecutor({ x: { command: [script] } }, { default: "x" });
}

describe("live transcript and live file", () => {
  test("the transcript grows while the agent runs; the live file exists only during the run", async () => {
    const dir = home();
    const env = { FACTORY_HOME: dir };
    const transcriptFile = transcriptPath("acme/widgets", 3, env);
    const liveFile = livePath("acme/widgets", 3, env);
    const ex = agent(`echo first line\nsleep 1\necho second line`);
    const running = ex.runStage({ stage: "build", issue: 3, cwd: dir, maxBudgetUsd: 1, transcriptFile, liveFile });
    await until(() => existsSync(transcriptFile) && readFileSync(transcriptFile, "utf8").includes("first line"));
    expect(readFileSync(transcriptFile, "utf8")).not.toContain("second line");
    const live = JSON.parse(readFileSync(liveFile, "utf8"));
    expect(live).toMatchObject({ issue: 3, stage: "build", agent: "x", transcriptFile });
    expect(live.pid).toBeGreaterThan(0);
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(existsSync(liveFile)).toBe(false);
    const text = readFileSync(transcriptFile, "utf8");
    expect(text).toContain("=== build #3");
    expect(text).toContain("second line");
    expect(text).toContain("=== build exit 0 ===");
  });

  test("the takeover marker turns a SIGTERM of the group into 'operator takeover', and is cleared", async () => {
    const dir = home();
    const env = { FACTORY_HOME: dir };
    const liveFile = livePath("acme/widgets", 4, env);
    const ex = agent(`echo working\nsleep 30`);
    const running = ex.runStage({
      stage: "build",
      issue: 4,
      cwd: dir,
      maxBudgetUsd: 1,
      transcriptFile: transcriptPath("acme/widgets", 4, env),
      liveFile,
    });
    await until(() => existsSync(liveFile));
    const { pid } = JSON.parse(readFileSync(liveFile, "utf8"));
    writeFileSync(takeoverMarker(liveFile), "");
    process.kill(-pid, "SIGTERM");
    const result = await running;
    expect(result.killedReason).toBe(OPERATOR_TAKEOVER);
    expect(existsSync(liveFile)).toBe(false);
    expect(existsSync(takeoverMarker(liveFile))).toBe(false);
  });

  test("a SIGTERM without the marker is not a takeover", async () => {
    const dir = home();
    const liveFile = livePath("acme/widgets", 5, { FACTORY_HOME: dir });
    const ex = agent(`sleep 30`);
    const running = ex.runStage({ stage: "build", issue: 5, cwd: dir, maxBudgetUsd: 1, liveFile });
    await until(() => existsSync(liveFile));
    process.kill(-JSON.parse(readFileSync(liveFile, "utf8")).pid, "SIGTERM");
    expect((await running).killedReason).not.toBe(OPERATOR_TAKEOVER);
  });
});

describe("claude session id", () => {
  test("the init line yields a session event", () => {
    const events = parseStreamJsonLine(JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "session", sessionId: "abc-123" }));
  });

  test("state keeps the newest session per issue for takeover", () => {
    const state = new FactoryState(":memory:");
    const row = {
      repo: "a/b",
      issue: 1,
      agent: "claude",
      model: null,
      started_at: "",
      finished_at: "",
      duration_ms: 1,
      tool_calls: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_cached: 0,
      cost_usd: null,
      usage_complete: 0,
      exit_code: 0,
      killed_reason: null,
    };
    expect(state.lastSession("a/b", 1)).toBeUndefined();
    state.recordStageRun({ ...row, stage: "plan", session_id: "s-plan" });
    state.recordStageRun({ ...row, stage: "build", session_id: "s-build" });
    state.recordStageRun({ ...row, stage: "verify" });
    expect(state.lastSession("a/b", 1)).toEqual({ stage: "build", agent: "claude", session_id: "s-build" });
    state.close();
  });
});

describe("renderRunSummary", () => {
  const run = (over: Partial<StageRun>): StageRun => ({
    id: 1,
    repo: "a/b",
    issue: 1,
    stage: "build",
    agent: "claude",
    model: "opus",
    started_at: "",
    finished_at: "",
    duration_ms: 65_000,
    tool_calls: 4,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cached: 0,
    tokens_cache_write: 0,
    cost_usd: 0.5,
    usage_complete: 1,
    exit_code: 0,
    killed_reason: null,
    session_id: null,
    verdict: null,
    ...over,
  });

  test("a clean run lists every stage under went well and nothing under needed help", () => {
    const out = renderRunSummary(
      [run({ stage: "triage" }), run({ stage: "verify" }), run({ stage: "retro" as StageRun["stage"] })],
      { rejectRounds: 0, retries: 0 },
    );
    expect(out).toContain("| triage | claude (opus) | 1m 5s | 4 | $0.50 | ok |");
    expect(out).not.toContain("| retro |");
    expect(out).toContain("2 stage runs, 2m 10s, $1.00.");
    expect(out).toContain("- triage, verify passed on the first attempt");
    expect(out).toContain("- verify approved on the first round");
    expect(out).toMatch(/\*\*Needed help\*\*\n\n- nothing$/);
  });

  test("a verify row shows its verdict, and an uncertain one is help, not a first-try pass", () => {
    const out = renderRunSummary([run({ stage: "triage" }), run({ stage: "verify", verdict: "uncertain" })], {
      rejectRounds: 0,
      retries: 0,
    });
    expect(out).toContain("| verify | claude (opus) | 1m 5s | 4 | $0.50 | uncertain |");
    expect(out).toContain("- triage passed on the first attempt");
    expect(out).not.toContain("verify approved");
    expect(out).toContain("- verify: uncertain");
    expect(renderRunSummary([run({ stage: "verify", verdict: "pass" })], { rejectRounds: 0, retries: 0 })).toContain(
      "- verify approved on the first round",
    );
    expect(
      renderRunSummary([run({ stage: "verify" })], { rejectRounds: 0, retries: 0, proof: "unavailable" }),
    ).toContain("Proof: unavailable: the repo has no test gate");
    expect(renderRunSummary([run({ stage: "verify" })], { rejectRounds: 0, retries: 0 })).not.toContain("Proof:");
  });

  test("takeovers, reruns, rejections, retries and unknown cost are all named", () => {
    const out = renderRunSummary(
      [
        run({ killed_reason: OPERATOR_TAKEOVER, exit_code: 143 }),
        run({ cost_usd: null }),
        run({ stage: "verify", killed_reason: "a | b" }),
      ],
      { rejectRounds: 1, retries: 2 },
    );
    expect(out).toContain("$1.00 plus 1 not reported");
    expect(out).toContain("- build ran 2 times");
    expect(out).toContain("- build: taken over by an operator");
    expect(out).toContain("- verify: a \\| b");
    expect(out).toContain("- 1 verify rejection(s)");
    expect(out).toContain("- 2 `/factory retry`");
    expect(out).toContain("- nothing on the first try");
  });
});

describe("factory takeover helpers", () => {
  test("stopRunningStage stops a live stage as a takeover and returns once the executor is done", async () => {
    const dir = home();
    const liveFile = livePath("acme/widgets", 6, { FACTORY_HOME: dir });
    const running = agent(`sleep 30`).runStage({ stage: "build", issue: 6, cwd: dir, maxBudgetUsd: 1, liveFile });
    await until(() => existsSync(liveFile));
    expect(await stopRunningStage(liveFile, readLive(liveFile)!, 5000)).toBe(true);
    expect((await running).killedReason).toBe(OPERATOR_TAKEOVER);
  });

  test("the banner names the resume command and how to pass the folder-trust prompt", () => {
    expect(takeoverBanner(["claude", "--resume", "s1"], "/w/issue-3")).toEqual([
      "factory takeover: claude --resume s1  (in /w/issue-3; exit to hand back)",
      "factory takeover: Claude will ask to trust this worktree: choose Yes",
    ]);
    // The CLI prints it before it hands over the terminal.
    const bin = readFileSync("src/cli.ts", "utf8");
    expect(bin.indexOf("takeoverBanner(argv, worktree)")).toBeGreaterThan(-1);
    expect(bin.indexOf("takeoverBanner(argv, worktree)")).toBeLessThan(bin.indexOf("Bun.spawn(argv, { cwd: worktree"));
  });

  test("only a claude session can be resumed; any other agent is refused by name", () => {
    expect(resumeArgv("claude", { claude: { preset: "claude" } }, "s1")).toEqual(["claude", "--resume", "s1"]);
    expect(resumeArgv("opus", { opus: { preset: "claude", model: "opus" } }, "s2")).toEqual([
      "claude",
      "--resume",
      "s2",
    ]);
    expect(() => resumeArgv("codex", { codex: { preset: "codex" } }, "s3")).toThrow("agent codex cannot be resumed");
  });

  test("verify-agent fixtures default to the runner's tree, not the current directory", () => {
    expect(defaultFixtureDir("cursor")).toBe(join(import.meta.dir, "fixtures", "agents", "cursor"));
  });
});
