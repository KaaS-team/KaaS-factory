// The agent layer: the Claude command is pinned byte for byte, the config that
// picks an agent is validated, and an agent with no preset and no JSON output
// completes a whole run through CommandExecutor. Also structural: every stage's
// artifact contract reaches the prompt, and every preset can be diagnosed.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor, renderCommand, resolveAgent } from "../src/agents/executor";
import { artifactContract, renderPrompt, stripFrontmatter } from "../src/agents/prompt";
import { CLAUDE_STAGE_DEFAULTS, claudeArgs } from "../src/agents/presets/claude";
import { PRESETS } from "../src/agents/presets";
import {
  COMMENT_FILENAMES,
  JSON_FILENAMES,
  MAX_STEP_JSON_BYTES,
  readStageArtifacts,
  validateVerdict,
  writeGateEvidence,
} from "../src/artifacts";
import { configProblems, DEFAULT_CONFIG, mergeConfig } from "../src/config";
import type { StageName } from "../src/executor";
import { STAGE_DISALLOWED_TOOLS, STAGE_GUIDANCE, STAGE_TOOLS, stageSettings } from "../src/stage-permissions";
import { FactoryState } from "../src/state";
import { LABEL } from "../src/labels";
import { processReadyIssue } from "../src/watch";
import { FAILURE_TAIL_BYTES, failureTail } from "../src/engine/common";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

const STAGES: StageName[] = ["triage", "plan", "build", "verify", "pr", "retro"];
// The stages a "shipped" run (no merge, so no retro) actually executes.
const RUN_STAGES: StageName[] = ["triage", "plan", "build", "verify", "pr"];
const scratch = mkdtempSync(join(tmpdir(), "factory-agents-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("claude preset", () => {
  test("the argv is pinned byte for byte (v2.12.0 dropped --no-session-persistence for takeover)", () => {
    const opts = { stage: "build" as const, issue: 12, cwd: "/w", maxBudgetUsd: 5 };
    expect(claudeArgs(opts)).toEqual([
      "-p",
      "/factory-build 12",
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
      "Bash,Read,Write,Skill,Edit",
      "--settings",
      stageSettings("build", 12, undefined),
      "--append-system-prompt",
      STAGE_GUIDANCE,
      "--max-budget-usd",
      "5",
    ]);
    // Each shape dontAsk refused in the 2.1.289 repro; guard-paths.sh refuses the same set.
    for (const shape of [
      "> or >>",
      "$(...)",
      "backticks",
      "$?",
      "brace expansion",
      "cd",
      "VAR=value",
      "git restore --source=",
    ])
      expect(STAGE_GUIDANCE).toContain(shape);
    expect(STAGE_DISALLOWED_TOOLS).toContain("ScheduleWakeup");
    // Only plan and verify dispatch a subagent; only build and verify edit beyond their own artifacts.
    for (const stage of STAGES) {
      expect(STAGE_TOOLS[stage].includes("Agent"), stage).toBe(stage === "plan" || stage === "verify");
      expect(STAGE_TOOLS[stage].includes("Edit"), stage).toBe(stage === "build" || stage === "verify");
      for (const t of ["Bash", "Read", "Write", "Skill"]) expect(STAGE_TOOLS[stage], stage).toContain(t);
    }
    expect(PRESETS.claude!.command(opts, { preset: "claude" }, "").argv).toEqual(["claude", ...claudeArgs(opts)]);
  });

  test("a rebuild forks the last build session and is told why it came back", () => {
    const opts = { stage: "build" as const, issue: 12, cwd: "/w", maxBudgetUsd: 5 };
    const resumed = claudeArgs({ ...opts, resume: { sessionId: "s-1", failure: "gate red: test" } });
    expect(resumed.slice(0, 6)).toEqual([
      "-p",
      "/factory-build 12\n\nThe last attempt was sent back. The tail of why:\n\ngate red: test",
      "--resume",
      "s-1",
      "--fork-session",
      "--output-format",
    ]);
    expect(resumed.slice(5)).toEqual(claudeArgs(opts).slice(2));
  });

  test("a rebuild sees the last 12 KiB of the failure, where the error is", () => {
    expect(failureTail("short")).toBe("short");
    const long = `${"x".repeat(FAILURE_TAIL_BYTES)}THE ERROR`;
    expect(failureTail(long)).toHaveLength(FAILURE_TAIL_BYTES);
    expect(failureTail(long).endsWith("THE ERROR")).toBe(true);
    // A cut through a multi-byte character drops the broken half rather than send U+FFFD.
    expect(failureTail(`${"é".repeat(FAILURE_TAIL_BYTES)}`).startsWith("é")).toBe(true);
  });

  test("a configured model is added and nothing else changes", () => {
    const opts = { stage: "plan" as const, issue: 1, cwd: "/w", maxBudgetUsd: 2 };
    const argv = PRESETS.claude!.command(opts, { preset: "claude", model: "opus" }, "").argv;
    expect(argv.slice(0, -2)).toEqual(["claude", ...claudeArgs(opts)]);
    expect(argv.slice(-2)).toEqual(["--model", "opus"]);
  });

  // v3.0: the stages that classify or fill a template run cheap; plan, build and verify
  // keep the CLI default. A configured model replaces the stage model, never the effort.
  test("each stage gets its default model and effort, and a configured model wins", () => {
    const tail = (stage: StageName, model?: string) => {
      const opts = { stage, issue: 1, cwd: "/w", maxBudgetUsd: 2 };
      return PRESETS.claude!.command(opts, { preset: "claude", ...(model ? { model } : {}) }, "").argv.slice(
        claudeArgs(opts).length + 1,
      );
    };
    expect(Object.keys(CLAUDE_STAGE_DEFAULTS).sort()).toEqual([...STAGES].sort());
    for (const stage of ["triage", "pr", "retro"] as const)
      expect(tail(stage)).toEqual(["--model", "sonnet", "--effort", "low"]);
    for (const stage of ["plan", "build", "verify"] as const) expect(tail(stage)).toEqual([]);
    expect(tail("triage", "opus")).toEqual(["--model", "opus", "--effort", "low"]);
  });
});

describe("codex preset", () => {
  test("prompt on stdin, JSON events, sandbox by stage policy", () => {
    const inv = PRESETS.codex!.command(
      { stage: "build", issue: 1, cwd: "/w", maxBudgetUsd: 2 },
      { preset: "codex", model: "gpt-5.6-terra" },
      "the prompt",
    );
    expect(inv.argv).toEqual(["codex", "exec", "--json", "-s", "workspace-write", "-m", "gpt-5.6-terra", "-"]);
    expect(inv.stdin).toBe("the prompt");
    for (const stage of ["triage", "plan", "verify"] as const)
      expect(
        PRESETS.codex!.command({ stage, issue: 1, cwd: "/w", maxBudgetUsd: 2 }, { preset: "codex" }, "").argv,
      ).toContain("read-only");
    expect(
      PRESETS.codex!.command({ stage: "pr", issue: 1, cwd: "/w", maxBudgetUsd: 2 }, { preset: "codex" }, "").argv,
    ).toContain("workspace-write");
  });
});

describe("agents config", () => {
  test("the default is Claude for every stage", () => {
    expect(DEFAULT_CONFIG.stages).toEqual({ default: "claude" });
    expect(
      mergeConfig({ repo: "a/b", agents: { codex: { preset: "codex" } }, stages: { verify: "codex" } }).stages,
    ).toEqual({ default: "claude", verify: "codex" });
  });

  test.each([
    [{ agents: { x: {} } }, /needs a "preset" or a "command"/],
    [{ agents: { x: { preset: "nope" } } }, /unknown "nope"/],
    [{ agents: { x: { command: [] } } }, /must not be empty/],
    [{ agents: { x: { command: ["{{prompt}}"] } } }, /executable cannot be a placeholder/],
    [{ agents: { x: { command: ["a"], sandbox: true } } }, /unknown key/],
    [{ stages: { verify: "ghost" } }, /"ghost" is not an agent/],
    [{ stages: { deploy: "claude" } }, /unknown stage/],
  ])("refuses %j", (cfg, want) => {
    expect(configProblems({ repo: "a/b", ...cfg }).join("\n")).toMatch(want);
  });

  test("a valid mix is accepted", () => {
    expect(
      configProblems({
        repo: "a/b",
        agents: { codex: { preset: "codex" }, aider: { command: ["aider", "--message-file", "{{promptFile}}"] } },
        stages: { default: "claude", build: "aider" },
      }),
    ).toEqual([]);
  });

  test("resolveAgent picks the stage's agent, else the default, else claude", () => {
    const agents = { claude: { preset: "claude" }, codex: { preset: "codex" } };
    expect(resolveAgent(agents, { default: "claude", verify: "codex" }, "verify").name).toBe("codex");
    expect(resolveAgent(agents, { default: "codex" }, "plan").name).toBe("codex");
    expect(resolveAgent(agents, {}, "plan").name).toBe("claude");
    expect(() => resolveAgent(agents, { plan: "ghost" }, "plan")).toThrow(/not in config.agents/);
  });

  test("renderCommand fills placeholders and knows when the prompt is not on stdin", () => {
    const v = { prompt: "P", promptFile: "/f", model: "m" };
    expect(renderCommand(["a", "--model", "{{model}}"], v)).toEqual({ argv: ["a", "--model", "m"], usesStdin: true });
    expect(renderCommand(["a", "{{prompt}}"], v)).toEqual({ argv: ["a", "P"], usesStdin: false });
    expect(renderCommand(["a", "--f={{promptFile}}"], v)).toEqual({ argv: ["a", "--f=/f"], usesStdin: false });
  });
});

describe("the prompt", () => {
  test.each(STAGES)("%s: every artifact the stage may write is named in the contract", (stage) => {
    const c = artifactContract({ stage, issue: 4 });
    expect(c).toContain(JSON_FILENAMES[stage]);
    expect(c).toContain(COMMENT_FILENAMES[stage]);
    expect(c).toContain("question-comment.md");
    expect(c).toContain(".factory/runs/issue-4/");
  });

  test.each(STAGES)("%s: the rendered prompt is the skill body plus the contract", async (stage) => {
    const cwd = mkdtempSync(join(scratch, "prompt-"));
    cpSync(join(import.meta.dir, "../template/.claude/skills"), join(cwd, ".claude/skills"), { recursive: true });
    const prompt = await renderPrompt({ stage, issue: 4, cwd, maxBudgetUsd: 1 });
    const body = stripFrontmatter(readFileSync(join(cwd, `.claude/skills/factory-${stage}/SKILL.md`), "utf8")).trim();
    expect(prompt).toContain(body);
    expect(prompt).toContain("Issue number: 4");
    expect(prompt).toContain(artifactContract({ stage, issue: 4 }));
    expect(prompt).not.toContain("name: factory-");
  });

  test("a missing skill says how to fix it", async () => {
    await expect(renderPrompt({ stage: "plan", issue: 1, cwd: scratch, maxBudgetUsd: 1 })).rejects.toThrow(
      /factory install --update/,
    );
  });
});

describe("an agent with no preset", () => {
  class SkillGit extends FakeGit {
    override async ensureWorktree(cloneDir: string, worktreeDir: string, issue: number) {
      await super.ensureWorktree(cloneDir, worktreeDir, issue);
      cpSync(join(import.meta.dir, "../template/.claude/skills"), join(worktreeDir, ".claude/skills"), {
        recursive: true,
      });
    }
  }

  test("completes triage to PR from a script that only writes files", async () => {
    const workspacesDir = mkdtempSync(join(scratch, "ws-"));
    const cloneDir = mkdtempSync(join(scratch, "clone-"));
    const log = mkdtempSync(join(scratch, "log-"));
    process.env.FAKE_AGENT_LOG = log;
    const issue = baseIssue(1, [LABEL.ready]);
    const github = new FakeGitHub([issue]);
    const state = new FactoryState(":memory:");
    state.setToggle("auto_approve_low_risk", true);
    const config = mergeConfig({
      repo: "acme/widgets",
      agents: { scripted: { command: [join(import.meta.dir, "fixtures/agents/fake-agent.sh")] } },
      stages: { default: "scripted" },
    });
    const deps = {
      github,
      git: new SkillGit(),
      state,
      executor: new CommandExecutor(config.agents, config.stages),
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      cloneDir,
      workspacesDir,
    };
    try {
      expect(await processReadyIssue(issue, deps, config)).toBe("shipped");
    } finally {
      delete process.env.FAKE_AGENT_LOG;
    }
    expect(github.createdPrs[0]!.body).toContain("Closes #1");
    // Every stage was handed its contract on stdin.
    for (const stage of RUN_STAGES)
      expect(readFileSync(join(log, `${stage}.prompt`), "utf8")).toContain(JSON_FILENAMES[stage]);
    // The run history names the agent and says the numbers are not reported.
    const rows = state.listStageRuns("acme/widgets");
    expect(rows.map((r) => r.agent)).toEqual(Array(rows.length).fill("scripted"));
    expect(rows.length).toBe(5);
    state.close();
  });
});

describe("codex with read-only stages", () => {
  class SkillGit extends FakeGit {
    override async ensureWorktree(cloneDir: string, worktreeDir: string, issue: number) {
      await super.ensureWorktree(cloneDir, worktreeDir, issue);
      cpSync(join(import.meta.dir, "../template/.claude/skills"), join(worktreeDir, ".claude/skills"), {
        recursive: true,
      });
    }
  }
  const bin = mkdtempSync(join(scratch, "bin-"));
  symlinkSync(join(import.meta.dir, "fixtures/agents/fake-codex.ts"), join(bin, "codex"));

  async function run(n: number, bad?: string, outputSchema?: boolean) {
    const log = mkdtempSync(join(scratch, "log-"));
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    process.env.FAKE_AGENT_LOG = log;
    if (bad !== undefined) process.env.FAKE_BAD_REPLY = bad;
    const issue = baseIssue(n, [LABEL.ready]);
    const github = new FakeGitHub([issue]);
    const state = new FactoryState(":memory:");
    state.setToggle("auto_approve_low_risk", true);
    const config = mergeConfig({
      repo: "acme/widgets",
      agents: { codex: { preset: "codex", model: "gpt-5.6-terra", ...(outputSchema ? { outputSchema } : {}) } },
      stages: { default: "codex" },
    });
    const deps = {
      github,
      git: new SkillGit(),
      state,
      executor: new CommandExecutor(config.agents, config.stages),
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      cloneDir: mkdtempSync(join(scratch, "clone-")),
      workspacesDir: mkdtempSync(join(scratch, "ws-")),
    };
    try {
      return { result: await processReadyIssue(issue, deps, config), github, state, log };
    } finally {
      process.env.PATH = saved;
      delete process.env.FAKE_AGENT_LOG;
      delete process.env.FAKE_BAD_REPLY;
    }
  }

  test("triage, plan and verify run read-only and the runner writes their files; build writes its own", async () => {
    const { result, github, state, log } = await run(5);
    expect(result).toBe("shipped");
    expect(
      readFileSync(join(log, "sandboxes"), "utf8")
        .trim()
        .split("\n")
        .map((l) => l.trim()),
    ).toEqual([
      "triage=read-only",
      "plan=read-only",
      "build=workspace-write",
      "verify=read-only",
      "pr=workspace-write",
    ]);
    expect(github.createdPrs[0]!.body).toContain("Closes #5");
    // Cached tokens are stored, and gpt-5.6-terra has no price, so the cost is "not reported".
    const [row] = state.listStageRuns("acme/widgets");
    expect([row!.tokens_cached, row!.usage_complete]).toEqual([40, 0]);
    state.close();
  });

  test("outputSchema hands the read-only stages a schema file, and only those", async () => {
    const { result, log, state } = await run(7, undefined, true);
    expect(result).toBe("shipped");
    expect(
      readFileSync(join(log, "sandboxes"), "utf8")
        .trim()
        .split("\n")
        .map((l) => l.trim()),
    ).toEqual([
      "triage=read-only schema",
      "plan=read-only schema",
      "build=workspace-write",
      "verify=read-only schema",
      "pr=workspace-write",
    ]);
    state.close();
  });

  test("a read-only reply that is not the envelope fails the stage instead of shipping", async () => {
    const { result, state } = await run(6, "I looked at the code and it seems fine.");
    expect(result).toBe("failed");
    state.close();
  });
});

describe("the runner refuses a self-contradicting verdict", () => {
  test("pass with a blocking finding goes to a human, and the verdict is never posted", async () => {
    const workspacesDir = mkdtempSync(join(scratch, "ws-"));
    process.env.FAKE_VERDICT = JSON.stringify({
      result: "pass",
      rounds: 1,
      findings: [{ severity: "must", confidence: 5, what: "drops a cent" }],
    });
    const issue = baseIssue(2, [LABEL.ready]);
    const github = new FakeGitHub([issue]);
    const state = new FactoryState(":memory:");
    const config = mergeConfig({
      repo: "acme/widgets",
      agents: { scripted: { command: [join(import.meta.dir, "fixtures/agents/fake-agent.sh")] } },
      stages: { default: "scripted" },
    });
    class SkillGit extends FakeGit {
      override async ensureWorktree(c: string, w: string, n: number) {
        await super.ensureWorktree(c, w, n);
        cpSync(join(import.meta.dir, "../template/.claude/skills"), join(w, ".claude/skills"), { recursive: true });
      }
    }
    try {
      const deps = {
        github,
        git: new SkillGit(),
        state,
        executor: new CommandExecutor(config.agents, config.stages),
        gateRunner: new FakeGateRunner(),
        holdoutRunner: new FakeHoldoutRunner(),
        cloneDir: scratch,
        workspacesDir,
      };
      state.setToggle("auto_approve_low_risk", true);
      expect(await processReadyIssue(issue, deps, config)).toBe("needs-human");
    } finally {
      delete process.env.FAKE_VERDICT;
    }
    expect(state.getRun("acme/widgets", 2)!.reason).toMatch(/blocking finding: drops a cent/);
    expect(github.createdPrs).toHaveLength(0);
    state.close();
  });
});

describe("every preset is diagnosable", () => {
  test("has a binary, parses a blank line to nothing, and never lets the prompt into argv when it owns stdin", () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(preset.name).toBe(name);
      expect(preset.binary.length).toBeGreaterThan(0);
      expect(preset.parseLine("")).toEqual([]);
      const inv = preset.command(
        { stage: "plan", issue: 1, cwd: "/w", maxBudgetUsd: 1 },
        { preset: name },
        "SECRET-PROMPT",
      );
      expect(inv.argv[0]).toBe(preset.binary);
      if (!preset.ownsPrompt && inv.stdin !== undefined) expect(inv.argv.join(" ")).not.toContain("SECRET-PROMPT");
    }
  });
});

describe("verdict rules", () => {
  const f = (severity: string, confidence: number) => ({ severity, confidence, what: "x" });
  const check = (v: unknown) => validateVerdict(v);

  test("a consistent verdict is accepted, old string findings included", () => {
    expect(check({ result: "pass", rounds: 1, findings: [], criteria: [{ id: "AC-1", status: "pass" }] }).ok).toBe(
      true,
    );
    expect(check({ result: "reject", rounds: 1, findings: ["a", f("must", 5)] }).ok).toBe(true);
    expect(check({ result: "pass", rounds: 1, findings: ["note", f("could", 5), f("must", 2)] }).ok).toBe(true);
  });

  test.each([
    [[], /not a JSON object/],
    [{ result: "pass", rounds: 1, findings: [], extra: 1 }, /unknown field "extra"/],
    [{ result: "ok", rounds: 1, findings: [] }, /"result" must be/],
    [{ result: "pass", rounds: 1.5, findings: [] }, /"rounds"/],
    [{ result: "pass", rounds: 1, findings: [f("must", 9)] }, /confidence/],
    [{ result: "pass", rounds: 1, findings: [{ ...f("must", 1), color: "red" }] }, /unknown field "color"/],
    [{ result: "pass", rounds: 1, findings: [f("must", 4)] }, /pass but lists a blocking finding/],
    [{ result: "pass", rounds: 1, findings: [f("should", 3)] }, /pass but lists a blocking finding/],
    [
      { result: "pass", rounds: 1, findings: [], criteria: [{ id: "AC-2", status: "unverified" }] },
      /AC-2 is unverified/,
    ],
    [{ result: "pass", rounds: 1, findings: [], criteria: [{ id: "two", status: "pass" }] }, /look like AC-1/],
  ])("refuses %j", (v, want) => {
    const r = check(v);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(want);
  });

  test("a step result that is oversize, not JSON or not an object reads as absent", async () => {
    const cwd = mkdtempSync(join(scratch, "art-"));
    const dir = join(cwd, ".factory/runs/issue-3");
    mkdirSync(dir, { recursive: true });
    for (const [body, name] of [
      ["x".repeat(MAX_STEP_JSON_BYTES + 1), "big"],
      ["{nope", "junk"],
      ["[1]", "array"],
    ] as const) {
      writeFileSync(join(dir, "verdict.json"), name === "big" ? JSON.stringify({ result: "pass", pad: body }) : body);
      expect((await readStageArtifacts(cwd, 3, "verify")).json, name).toBeUndefined();
    }
  });

  test("build hands the verifier gate evidence tied to the tree it measured", async () => {
    const cwd = mkdtempSync(join(scratch, "gate-"));
    await writeGateEvidence(cwd, 5, { line: "FACTORY_GATES: status=GREEN", status: "GREEN", tree: "abc" });
    expect(JSON.parse(readFileSync(join(cwd, ".factory/runs/issue-5/gate.json"), "utf8"))).toEqual({
      line: "FACTORY_GATES: status=GREEN",
      status: "GREEN",
      tree: "abc",
    });
  });

  test("the verify skill and reviewer teach the same schema the runner enforces", () => {
    const skill = readFileSync(join(import.meta.dir, "../template/.claude/skills/factory-verify/SKILL.md"), "utf8");
    for (const word of [
      "gate.json",
      "proof.json",
      "passes-without",
      "unverified",
      "must|should|could",
      "16 KiB",
      "AC-1",
    ])
      expect(skill).toContain(word);
    // The tree check moved with the hand proof into prove.md, read when the runner could not run it.
    expect(
      readFileSync(join(import.meta.dir, "../template/.claude/skills/factory-verify/references/prove.md"), "utf8"),
    ).toContain("HEAD^{tree}");
    expect(readFileSync(join(import.meta.dir, "../template/.claude/agents/factory-reviewer.md"), "utf8")).toContain(
      "confidence 0-5",
    );
  });
});

describe("skill text the runner depends on", () => {
  const skill = (n: string) => readFileSync(join(import.meta.dir, `../template/.claude/skills/${n}/SKILL.md`), "utf8");
  test("build stops at 3 gate runs, plan never renumbers, every step skill teaches outcome", () => {
    expect(skill("factory-build")).toContain("Stop after 3");
    expect(skill("factory-build")).not.toContain("a few times");
    expect(skill("factory-plan")).toContain("never renumbered");
    for (const n of ["triage", "plan", "build", "verify"]) expect(skill(`factory-${n}`), n).toContain("outcome");
  });
  test("the verdict template renders a per-criterion status", () => {
    const t = readFileSync(
      join(import.meta.dir, "../template/.claude/skills/factory-comment/assets/verdict.md"),
      "utf8",
    );
    expect(t).toContain("{{pass|fail|unverified}}");
    expect(t).not.toContain("pass_or_fail");
  });
});

describe("hardening from the verifier report", () => {
  test.each([
    [{ agents: { x: { command: [""] } } }, /must not be empty/],
    [{ agents: { x: { command: ["sh", "-c", "run {{prompt}}"] } } }, /must not be an argument of a shell/],
    [{ agents: { x: { command: ["/bin/bash", "-c", "{{prompt}}"] } } }, /must not be an argument of a shell/],
  ])("refuses %j", (cfg, want) => {
    expect(configProblems({ repo: "a/b", ...cfg }).join("\n")).toMatch(want);
  });

  test("a shell that reads the prompt from a file is fine", () => {
    expect(configProblems({ repo: "a/b", agents: { x: { command: ["sh", "run.sh", "{{promptFile}}"] } } })).toEqual([]);
  });

  test("doctor does not require claude when every stage names another agent", async () => {
    const { runDoctor } = await import("../src/doctor");
    const deps = {
      github: { authStatus: async () => ({ ok: true, detail: "" }), listLabels: async () => [] } as never,
      git: { run: async () => ({ stdout: "x", stderr: "", code: 0 }) },
      which: async () => true,
      fileExists: async () => true,
      readFile: async () => "{}",
      isExecutable: async () => true,
    };
    const all = Object.fromEntries(STAGES.map((s) => [s, "codex"]));
    const checks = await runDoctor(deps, {
      repo: "a/b",
      cloneDir: "/x",
      baselineTag: "b",
      agents: { claude: { preset: "claude" }, codex: { preset: "codex" } },
      stages: { default: "claude", ...all },
    });
    expect(checks.map((c) => c.name)).toContain("codex on PATH");
    expect(checks.map((c) => c.name)).not.toContain("claude on PATH");
  });

  test("a grandchild that leaves the process group cannot hang the stage past the timeout", async () => {
    const cwd = mkdtempSync(join(scratch, "setsid-"));
    cpSync(join(import.meta.dir, "../template/.claude/skills"), join(cwd, ".claude/skills"), { recursive: true });
    const script = join(cwd, "escape.sh");
    writeFileSync(script, `#!/bin/sh\nperl -e 'use POSIX; POSIX::setsid(); exec "sleep","4719"' &\nsleep 30\n`, {
      mode: 0o755,
    });
    const ex = new CommandExecutor({ x: { command: [script] } }, { default: "x" });
    const t0 = Date.now();
    const r = await ex.runStage({ stage: "triage", issue: 1, cwd, maxBudgetUsd: 1, timeoutMinutes: 0.02 });
    Bun.spawnSync(["pkill", "-f", "sleep 4719"]);
    expect(r.killedReason).toMatch(/stageTimeoutMinutes/);
    expect(Date.now() - t0).toBeLessThan(6000);
  });
});

describe("preset-less command agents", () => {
  test("a bare codex exec command gets the codex preset and --json", () => {
    const a = resolveAgent(
      { codex: { command: ["env", "X=1", "codex", "exec", "{{prompt}}"] } },
      { default: "codex" },
      "triage",
    );
    expect(a.preset).toBe(PRESETS.codex);
    expect(a.config.command).toEqual(["env", "X=1", "codex", "exec", "--json", "{{prompt}}"]);
  });
  test("an unrecognised command is left alone", () => {
    const a = resolveAgent(
      { aider: { command: ["aider", "--message", "{{prompt}}"] } },
      { default: "aider" },
      "triage",
    );
    expect(a.preset).toBeUndefined();
  });
});
