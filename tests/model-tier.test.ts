// Model routing by size and risk: the tier rule, where its inputs come from, and that the
// executor runs the tier's model, so a cheap change never pays for the strong model.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import { configProblems, mergeConfig } from "../src/config";
import { LARGE_MIN_FILES, SMALL_MAX_FILES, scopeFrom, tierFor } from "../src/core/model-tier";
import { scopeOf } from "../src/engine/common";
import { baseIssue } from "./harness";

const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.ts`);

describe("model tier", () => {
  test("small only when low risk and few files; large when high risk or many files", () => {
    expect(tierFor({ risk: "low", files: SMALL_MAX_FILES })).toBe("small");
    expect(tierFor({ risk: "low", files: SMALL_MAX_FILES + 1 })).toBeUndefined();
    expect(tierFor({ risk: "medium", files: 1 })).toBeUndefined();
    expect(tierFor({ risk: "high", files: 1 })).toBe("large");
    expect(tierFor({ risk: "low", files: LARGE_MIN_FILES })).toBe("large");
    expect(tierFor(undefined)).toBeUndefined();
  });

  test("the plan's judgement wins over the triage's, and malformed data picks no tier", () => {
    expect(scopeFrom({ risk: "high", files: files(1) }, { risk: "low", files_expected: [] })).toEqual({
      risk: "high",
      files: 1,
    });
    expect(scopeFrom(undefined, { risk: "low", files_expected: files(2) })).toEqual({ risk: "low", files: 2 });
    expect(scopeFrom({ risk: "tiny", files: [] }, undefined)).toBeUndefined();
  });

  test("a stage reads its scope from the thread's data markers; triage reads none", () => {
    const issue = baseIssue(1, []);
    issue.comments = [
      {
        id: 1,
        author: "bot",
        authorAssociation: "OWNER",
        body: `<!-- factory:data ${JSON.stringify({ stage: "triage", json: { risk: "low", files_expected: files(1) } })} -->`,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    expect(scopeOf(issue, "build")).toEqual({ scope: { risk: "low", files: 1 } });
    expect(scopeOf(issue, "triage")).toEqual({});
  });

  test("the executor runs the tier's model, and the agent's own model when no tier fits", async () => {
    const agents = { x: { command: ["true", "{{model}}"], model: "mid", models: { small: "cheap", large: "strong" } } };
    const cwd = mkdtempSync(join(tmpdir(), "factory-tier-"));
    cpSync(join(import.meta.dir, "../template/.claude/skills"), join(cwd, ".claude/skills"), { recursive: true });
    const run = (scope?: { risk: "low" | "medium" | "high"; files: number }) =>
      new CommandExecutor(agents, { default: "x" }).runStage({
        stage: "plan",
        issue: 1,
        cwd,
        maxBudgetUsd: 1,
        ...(scope ? { scope } : {}),
      });
    expect((await run({ risk: "low", files: 1 })).model).toBe("cheap");
    expect((await run({ risk: "high", files: 1 })).model).toBe("strong");
    expect((await run({ risk: "medium", files: 5 })).model).toBe("mid");
    expect((await run()).model).toBe("mid");
  });

  test("config accepts models.small and models.large and nothing else", () => {
    const cfg = (models: unknown) =>
      configProblems(mergeConfig({ repo: "a/b", agents: { x: { preset: "codex", models } as never }, stages: {} }));
    expect(cfg({ small: "a", large: "b" })).toEqual([]);
    expect(cfg({ medium: "a" }).join()).toContain("agents.x.models.medium: unknown key");
  });
});
