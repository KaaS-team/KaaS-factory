// E13.3: the always-loaded context is measured per run, and its cap only goes down.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import {
  ALWAYS_LOADED_CAP_TOKENS,
  CAP_SLACK,
  CONTEXT_TOKENS_FILE,
  measureAlwaysLoaded,
  recordAlwaysLoaded,
  tokensOf,
} from "../src/context";
import { templateDir } from "../src/template-root";

mkdirSync(tmpdir(), { recursive: true });
const dir = () => mkdtempSync(join(tmpdir(), "factory-budget-"));

function skill(cwd: string, name: string, description: string) {
  mkdirSync(`${cwd}/.claude/skills/${name}`, { recursive: true });
  writeFileSync(
    `${cwd}/.claude/skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
  );
}

describe("always-loaded tokens", () => {
  test("counts the context file, unscoped rules, skill descriptions and lessons, not scoped rules or skill bodies", async () => {
    const cwd = dir();
    writeFileSync(`${cwd}/CLAUDE.md`, "c".repeat(400));
    mkdirSync(`${cwd}/.claude/rules`, { recursive: true });
    writeFileSync(`${cwd}/.claude/rules/always.md`, "r".repeat(200));
    writeFileSync(`${cwd}/.claude/rules/scoped.md`, `---\npaths:\n  - "src/**"\n---\n${"s".repeat(4000)}`);
    skill(cwd, "factory-build", "d".repeat(80));
    mkdirSync(`${cwd}/.factory/memory`, { recursive: true });
    writeFileSync(`${cwd}/.factory/memory/lessons.md`, `- ${"l".repeat(100)}\n`);
    const m = await measureAlwaysLoaded(cwd);
    expect(m.parts.context).toBe(100);
    expect(m.parts.rules).toBe(50);
    expect(m.parts.skills).toBe(tokensOf(`- factory-build: ${"d".repeat(80)}`));
    expect(m.parts.lessons).toBeGreaterThan(0);
    expect(m.tokens).toBe(m.parts.context + m.parts.rules + m.parts.skills + m.parts.lessons);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("counts AGENTS.md once when CLAUDE.md imports it", async () => {
    const cwd = dir();
    writeFileSync(`${cwd}/CLAUDE.md`, "@AGENTS.md\n");
    writeFileSync(`${cwd}/AGENTS.md`, "a".repeat(400));
    expect((await measureAlwaysLoaded(cwd)).parts.context).toBeGreaterThanOrEqual(100);
    expect((await measureAlwaysLoaded(cwd, { contextFile: "AGENTS.md" })).parts.context).toBe(100);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("a run records its tokens and whether they are over the cap", async () => {
    const cwd = dir();
    writeFileSync(`${cwd}/CLAUDE.md`, "x".repeat((ALWAYS_LOADED_CAP_TOKENS + 10) * 4));
    await recordAlwaysLoaded(cwd, 7);
    const rec = JSON.parse(readFileSync(`${cwd}/${runDir(7)}/${CONTEXT_TOKENS_FILE}`, "utf8"));
    expect(rec.tokens).toBeGreaterThan(ALWAYS_LOADED_CAP_TOKENS);
    expect(rec.cap).toBe(ALWAYS_LOADED_CAP_TOKENS);
    expect(rec.over).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("the cap ratchets down", () => {
  test("the shipped template fits the cap", async () => {
    expect((await measureAlwaysLoaded(templateDir())).tokens).toBeLessThanOrEqual(ALWAYS_LOADED_CAP_TOKENS);
  });

  test("the cap sits within 10% of what the template measures, so it is lowered when the template shrinks", async () => {
    const { tokens } = await measureAlwaysLoaded(templateDir());
    expect(ALWAYS_LOADED_CAP_TOKENS).toBeLessThanOrEqual(Math.ceil(tokens * (1 + CAP_SLACK)));
  });
});

describe("a stage run records its always-loaded tokens", () => {
  test("CommandExecutor leaves context-tokens.json in the run dir", async () => {
    const { CommandExecutor } = await import("../src/agents/executor");
    const { cpSync } = await import("node:fs");
    const cwd = dir();
    cpSync(join(import.meta.dir, "../template/.claude/skills"), join(cwd, ".claude/skills"), { recursive: true });
    const ex = new CommandExecutor({ x: { command: ["true"] } }, { default: "x" });
    await ex.runStage({ stage: "triage", issue: 3, cwd, maxBudgetUsd: 1, timeoutMinutes: 0.1 });
    const rec = JSON.parse(readFileSync(`${cwd}/${runDir(3)}/${CONTEXT_TOKENS_FILE}`, "utf8"));
    expect(rec.tokens).toBeGreaterThan(0);
    rmSync(cwd, { recursive: true, force: true });
  });
});
