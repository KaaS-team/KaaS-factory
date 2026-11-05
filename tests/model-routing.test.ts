// Model routing per workflow step: `model: auto` picks by step from the agent's models, a named
// model is used as given, and a model outside the team's allow list is refused at dispatch.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import { applyTeam } from "../src/team/apply";
import { autoTier } from "../src/core/model-tier";
import { stepOpts } from "../src/core/workflow";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config";
import { parseWorkflowText } from "../src/engine/workflows";
import { writeFileSync } from "node:fs";
import { afterAll } from "bun:test";
import { engine, removeEngineDirs } from "./engine-harness";

const agents = { x: { command: ["true", "{{model}}"], model: "mid", models: { small: "cheap", large: "strong" } } };

function cwd(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "factory-route-"));
  cpSync(join(import.meta.dir, "../template/.claude/skills"), join(dir, ".claude/skills"), { recursive: true });
  return dir;
}

const run = (
  stage: "triage" | "plan" | "build" | "verify" | "pr",
  extra: Record<string, unknown> = {},
  dir = cwd(),
  ag: Record<string, unknown> = agents,
) =>
  new CommandExecutor(ag as never, { default: "x" }).runStage({
    stage,
    issue: 1,
    cwd: dir,
    maxBudgetUsd: 1,
    ...extra,
  });

const WF = (model: string, check = "") => `
name: t
steps:
  triage:
    uses: triage
    label: factory:triaging
    model: ${model}
    next: plan
  plan:
    uses: plan
    label: factory:planning
    next: lint
  lint:
    uses: check
    label: factory:linting
    run: "true"${check}
    next: pr
  pr:
    uses: pr
    label: factory:opening
`;

describe("model: auto per step", () => {
  test("auto: cheap for triage and pr, strong for plan and verify, the size tier for build", () => {
    expect(autoTier("triage", undefined)).toBe("small");
    expect(autoTier("pr", undefined)).toBe("small");
    expect(autoTier("plan", undefined)).toBe("large");
    expect(autoTier("verify", undefined)).toBe("large");
    expect(autoTier("build", { risk: "low", files: 1 })).toBe("small");
    expect(autoTier("build", { risk: "high", files: 1 })).toBe("large");
  });

  test("the executor runs the auto model of each step", async () => {
    const dir = cwd();
    expect((await run("triage", { stepModel: "auto" }, dir)).model).toBe("cheap");
    expect((await run("plan", { stepModel: "auto" }, dir)).model).toBe("strong");
    expect((await run("pr", { stepModel: "auto" }, dir)).model).toBe("cheap");
  });

  test("auto on an agent with no models leaves its own model", async () => {
    const bare = { x: { command: ["true", "{{model}}"], model: "mid" } };
    expect((await run("plan", { stepModel: "auto" }, cwd(), bare)).model).toBe("mid");
  });

  test("a named model is used as given, and a step-pinned agent takes it too", async () => {
    expect((await run("plan", { stepModel: "pinned" })).model).toBe("pinned");
    expect((await run("plan", { stepModel: "pinned", agent: "x" })).model).toBe("pinned");
  });

  test("no step model keeps today's behaviour", async () => {
    expect((await run("plan", { scope: { risk: "low", files: 1 } })).model).toBe("cheap");
    expect((await run("plan")).model).toBe("mid");
  });
});

describe("the team's allowed models", () => {
  test("an allowed model runs", async () => {
    expect((await run("plan", { stepModel: "pinned", allowedModels: ["pinned", "mid"] })).model).toBe("pinned");
  });

  test("a model outside the list is refused, naming the model and the list", async () => {
    const err = await run("plan", { stepModel: "other", allowedModels: ["a", "b"] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('"other"');
    expect((err as Error).message).toContain("a, b");
  });

  test("auto is refused too when its pick is not on the list", async () => {
    const err = await run("plan", { stepModel: "auto", allowedModels: ["cheap"] }).catch((e: Error) => e);
    expect((err as Error).message).toContain('"strong"');
  });

  test("the policy's models reach config.modelAllow", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-team-"));
    mkdirSync(join(repo, ".factory/team"), { recursive: true });
    writeFileSync(join(repo, ".factory/team/org.yml"), "name: o\npolicy:\n  models: [m1, m2]\n");
    writeFileSync(join(repo, ".factory/team/t.yml"), "name: t\nrepos: [a/b]\n");
    const config = mergeConfig({ repo: "a/b" });
    const out = applyTeam({ repoDir: repo, config, defaults: DEFAULT_CONFIG, raw: {}, check: () => [] });
    expect(out.problems).toEqual([]);
    expect(out.config.modelAllow).toEqual(["m1", "m2"]);
  });
});

describe("the workflow step's model", () => {
  test("a step reads model: and hands it to the stage as stepModel", () => {
    const r = parseWorkflowText(WF("auto"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(stepOpts(r.workflow.steps.triage!).stepModel).toBe("auto");
  });

  test("a bad model, or one on a step that runs no agent, is a problem", () => {
    expect(parseWorkflowText(WF("'a b'"))).toMatchObject({ ok: false });
    const r = parseWorkflowText(WF("auto", "\n    model: auto"));
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toContain("steps.lint.model: a check step runs no agent");
  });
});

describe("the engine hands the step model and the allow list to the stage", () => {
  afterAll(removeEngineDirs);
  test("triage gets its step's model and config.modelAllow", async () => {
    const r = parseWorkflowText(WF("auto"));
    if (!r.ok) throw new Error(r.problems.join("; "));
    const e = engine(r.workflow, 0, {}, {}, {}, { config: { modelAllow: ["m1"] } as never });
    await e.run().catch(() => undefined);
    expect(e.executor.routing[0]).toEqual(["triage", "auto", ["m1"]]);
  });
});
