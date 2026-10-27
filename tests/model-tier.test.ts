// Model routing by size and risk: the tier rule, where its inputs come from, and that the
// executor runs the tier's model, so a cheap change never pays for the strong model.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import { configProblems, mergeConfig } from "../src/config";
import { LARGE_MIN_FILES, SMALL_MAX_FILES, scopeFrom, tierFor } from "../src/core/model-tier";
import { scopeOf } from "../src/engine/common";
import { parseWorkflowText } from "../src/engine/workflows";
import { engine, removeEngineDirs } from "./engine-harness";
import { baseIssue, fixtureFor } from "./harness";
import { PRICES, latestPricedModel } from "../src/pricing";
import { buildEscalation, buildFamily, latestModel } from "../src/core/model-tier";
import { readdirSync, readFileSync } from "node:fs";

const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.ts`);

describe("build model", () => {
  test("latestModel picks the newest priced id per family, pinned against PRICES", () => {
    for (const family of ["haiku", "sonnet", "opus"]) {
      const ids = Object.keys(PRICES).filter((k) => k.startsWith(`claude-${family}-`));
      const newest = ids
        .map((id) => ({ id, v: id.slice(`claude-${family}-`.length).split("-").map(Number) }))
        .sort((a, b) => b.v[0]! - a.v[0]! || (b.v[1] ?? 0) - (a.v[1] ?? 0))[0]!.id;
      expect(latestPricedModel(family)).toBe(newest);
    }
    expect(latestModel("sonnet", ["claude-sonnet-4-5", "claude-sonnet-5", "claude-sonnet-5-5-20260101"])).toBe(
      "claude-sonnet-5",
    );
    expect(latestModel("opus", ["claude-opus-5", "claude-opus-4-5"])).toBe("claude-opus-5");
    expect(latestModel("opus", ["claude-opus-9", "claude-opus-10"])).toBe("claude-opus-10");
    expect(latestModel("mistral", Object.keys(PRICES))).toBeUndefined();
  });

  test("buildFamily: plan.model, else the highest task model, else haiku", () => {
    expect(buildFamily({ model: "opus", tasks: [{ model: "haiku" }] })).toBe("opus");
    expect(buildFamily({ model: "gpt", tasks: [{ model: "sonnet" }, { model: "haiku" }, {}] })).toBe("sonnet");
    expect(buildFamily({ tasks: [{ model: "haiku" }, { model: "opus" }] })).toBe("opus");
    expect(buildFamily({})).toBe("haiku");
    expect(buildFamily(undefined)).toBe("haiku");
  });

  test("buildEscalation escalates to sonnet once, never higher", () => {
    expect(buildEscalation(0)).toBe("sonnet");
    expect(buildEscalation(0, "haiku")).toBe("sonnet");
    expect(buildEscalation(0, "opus")).toBeUndefined();
    expect(buildEscalation(1)).toBeUndefined();
    expect(buildEscalation(2)).toBeUndefined();
  });

  test("no literal Claude model id in src outside pricing.ts", () => {
    const src = join(import.meta.dir, "../src");
    const hits = readdirSync(src, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".ts"))
      .map((d) => join(d.parentPath, d.name))
      .filter((f) => !f.endsWith("/src/pricing.ts"))
      .filter((f) => /claude-(haiku|sonnet|opus)-/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("build model with a step-pinned agent", () => {
  afterAll(removeEngineDirs);
  const planOut = {
    "plan-comment.md": [
      "<!-- factory:plan v1 rev=1 -->",
      "### Acceptance criteria",
      "- **AC-1:** x: checked by `make test`",
      "### Tests to write first",
      "- `tests/x.test.ts`",
    ].join("\n"),
    "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true }),
  };
  const pinned = (agent: string, agents: Record<string, unknown>) => {
    const text = readFileSync(join(import.meta.dir, "..", "template", ".factory", "workflows", "feature-to-pr.yml"));
    const r = parseWorkflowText(text.toString().replace("    uses: build\n", `    uses: build\n    agent: ${agent}\n`));
    if (!r.ok) throw new Error(r.problems.join("; "));
    const config = { agents, toggles: { autoApproveLowRisk: true }, agentCommands: { build: ["make *"] } };
    const e = engine(r.workflow, 0, {}, {}, {}, { outputs: { plan: [planOut] }, config });
    e.gateRunner.line = "FACTORY_GATES: status=RED passed=1 failed=1 skipped=0 failed_gates=unit";
    return e;
  };
  const buildModels = (e: ReturnType<typeof pinned>) =>
    e.executor.models.filter(([s]) => s === "build").map(([, m]) => m);

  test("a pinned non-claude agent builds once, with no Claude id", async () => {
    const e = pinned("other", { other: { command: ["true"] } });
    expect(await e.run()).toBe("failed");
    expect(buildModels(e)).toEqual([undefined]);
  });

  test("a pinned claude agent gets the model pick and the one rerun", async () => {
    const e = pinned("pin", { pin: { preset: "claude" } });
    e.executor.push("build", 1, fixtureFor("build", 1), {
      "status-comment.md": "<!-- factory:status v1 -->\nb",
      "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
    });
    expect(await e.run()).toBe("failed");
    expect(buildModels(e)).toEqual([latestPricedModel("haiku"), latestPricedModel("sonnet")]);
  });
});

describe("model tier", () => {
  test("small only when low risk and few files; large when high risk or many files", () => {
    expect(tierFor({ risk: "low", files: SMALL_MAX_FILES })).toBe("small");
    expect(tierFor({ risk: "low", files: SMALL_MAX_FILES + 1 })).toBeUndefined();
    expect(tierFor({ risk: "medium", files: 1 })).toBeUndefined();
    expect(tierFor({ risk: "high", files: 1 })).toBe("large");
    expect(tierFor({ risk: "low", files: LARGE_MIN_FILES })).toBe("large");
    expect(tierFor(undefined)).toBeUndefined();
  });

  test("each reject climbs one tier and stops at large", () => {
    expect(tierFor({ risk: "low", files: 1 }, 1)).toBeUndefined();
    expect(tierFor({ risk: "low", files: 1 }, 2)).toBe("large");
    expect(tierFor({ risk: "medium", files: 5 }, 1)).toBe("large");
    expect(tierFor({ risk: "high", files: 1 }, 3)).toBe("large");
    expect(tierFor(undefined, 1)).toBe("large");
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
    // A marker pasted by an outside commenter is not read, so it cannot pick a cheaper model.
    issue.comments = issue.comments.map((c) => ({ ...c, authorAssociation: "NONE" }));
    expect(scopeOf(issue, "build")).toEqual({});
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
    const again = await new CommandExecutor(agents, { default: "x" }).runStage({
      stage: "build",
      issue: 1,
      cwd,
      maxBudgetUsd: 1,
      scope: { risk: "low", files: 1 },
      rejects: 2,
    });
    expect(again.model).toBe("strong");
  });

  test("config accepts models.small and models.large and nothing else", () => {
    const cfg = (models: unknown) =>
      configProblems(mergeConfig({ repo: "a/b", agents: { x: { preset: "codex", models } as never }, stages: {} }));
    expect(cfg({ small: "a", large: "b" })).toEqual([]);
    expect(cfg({ medium: "a" }).join()).toContain("agents.x.models.medium: unknown key");
  });
});
