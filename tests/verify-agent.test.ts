import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import { FixtureRecorder, scrubLine } from "../src/agents/record";
import { PRESETS } from "../src/agents/presets";
import { runDoctor } from "../src/doctor";
import { configFor, formatReport, matrixPlan, reportFor } from "../src/verify-agent";
import type { StageRun } from "../src/state";

const run = (over: Partial<StageRun>): StageRun => ({
  id: 1,
  repo: "a/b",
  issue: 1,
  stage: "build",
  agent: "codex",
  model: null,
  started_at: "",
  finished_at: "",
  duration_ms: 1500,
  tool_calls: 2,
  tokens_in: 10,
  tokens_out: 5,
  tokens_cached: 0,
  tokens_cache_write: 0,
  cost_usd: 0.25,
  usage_complete: 1,
  exit_code: 0,
  killed_reason: null,
  session_id: null,
  verdict: null,
  ...over,
});

describe("verify-agent", () => {
  test("configFor runs every stage on the preset and rejects an unknown name", () => {
    expect(configFor("codex")).toEqual({ agents: { codex: { preset: "codex" } }, stages: { default: "codex" } });
    expect(() => configFor("nope")).toThrow(/unknown agent "nope"/);
  });

  test("a report passes only when shipped with no failed stage", () => {
    const ok = reportFor("codex", [run({}), run({ stage: "verify" })], "shipped");
    expect(ok).toMatchObject({ pass: true, costUsd: 0.5, tokensIn: 20, durationMs: 3000 });
    expect(reportFor("codex", [run({ exit_code: 1 })], "shipped").pass).toBe(false);
    expect(reportFor("codex", [run({ killed_reason: "timeout" })], "shipped").failedStages).toEqual(["build"]);
    expect(reportFor("codex", [run({})], "needs-human").pass).toBe(false);
    expect(reportFor("codex", [], "shipped").pass).toBe(false);
    expect(formatReport(ok)).toContain("PASS codex");
    expect(formatReport(reportFor("codex", [], "failed"))).toContain("Do not flip `verified`");
  });

  test("the matrix runs installed presets and names the skipped", async () => {
    expect(await matrixPlan(async (bin) => bin === "claude")).toEqual({
      run: ["claude"],
      skipped: Object.keys(PRESETS).filter((n) => n !== "claude"),
    });
  });

  test("scrubbing removes env secrets, key shapes and home paths", () => {
    const line = JSON.stringify({
      a: "token supersecretvalue1",
      b: "sk-abcdefghijklmnopqrstuv",
      c: "/Users/x/work/f.ts",
      d: "keep me",
    });
    const out = scrubLine(line, { MY_API_KEY: "supersecretvalue1", PLAIN: "keep" }, ["/Users/x"]);
    expect(out).not.toContain("supersecretvalue1");
    expect(out).not.toContain("sk-abcdef");
    expect(out).not.toContain("/Users/x");
    expect(out).toContain("keep me");
    expect(scrubLine("/.claude/projects/-Users-x-repo/memory", {}, ["/Users/x"])).not.toContain("Users-x");
  });

  test("the executor records each stage's scrubbed stdout beside a fixture.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    const cwd = mkdtempSync(join(tmpdir(), "rec-cwd-"));
    cpSync(join(import.meta.dir, "../template/.claude/skills"), join(cwd, ".claude/skills"), { recursive: true });
    const script = join(cwd, "agent.sh");
    await Bun.write(script, `#!/bin/sh\necho '{"type":"x","text":"sk-abcdefghijklmnopqrstuv"}'\n`);
    Bun.spawnSync(["chmod", "+x", script]);
    const ex = new CommandExecutor({ x: { command: [script] } }, { default: "x" }, {}, new FixtureRecorder(dir, "x"));
    await ex.runStage({ stage: "triage", issue: 1, cwd, maxBudgetUsd: 1 });
    const lines = readFileSync(join(dir, "triage.jsonl"), "utf8");
    expect(lines).toContain("<redacted>");
    expect(lines).not.toContain("sk-abcdef");
    expect(JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"))).toEqual({ agent: "x", synthetic: false });
  });

  test("doctor warns, without failing, on an unverified preset", async () => {
    const deps = {
      github: { authStatus: async () => ({ ok: true, detail: "" }), listLabels: async () => [] } as never,
      git: { run: async () => ({ code: 0, stdout: "", stderr: "" }) } as never,
      which: async () => true,
      fileExists: async () => true,
      readFile: async () => "",
      isExecutable: async () => true,
    };
    const checks = await runDoctor(deps, {
      repo: "a/b",
      cloneDir: "/x",
      baselineTag: "t",
      agents: { codex: { preset: "codex" } },
      stages: { default: "codex" },
    });
    const c = checks.find((k) => k.name === 'agent "codex" is verified');
    expect(c).toMatchObject({ ok: false, warn: true });
    expect(c?.detail).toContain("factory verify-agent codex");
  });

  test("every preset says whether it is verified, and the runbook names each one", () => {
    const runbook = readFileSync(join(import.meta.dir, "../docs/verify-an-agent.md"), "utf8");
    expect(existsSync(join(import.meta.dir, "../scripts/agent-matrix.ts"))).toBe(true);
    for (const preset of Object.values(PRESETS)) expect(typeof preset.verified).toBe("boolean");
    expect(readFileSync(join(import.meta.dir, "../Makefile"), "utf8")).toMatch(/^agent-matrix:/m);
    expect(runbook).toContain("verify-agent");
    expect(runbook).toContain("agent-matrix");
  });

  test("a recording replaces a synthetic fixture instead of appending to it, and keeps extra keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    writeFileSync(join(dir, "triage.jsonl"), "synthetic\n");
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ agent: "x", synthetic: true, reportsUsage: false }));
    const rec = new FixtureRecorder(dir, "x", {});
    rec.line("triage", "one");
    rec.line("triage", "two");
    expect(readFileSync(join(dir, "triage.jsonl"), "utf8")).toBe("one\ntwo\n");
    expect(JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"))).toEqual({
      agent: "x",
      synthetic: false,
      reportsUsage: false,
    });
  });
});
