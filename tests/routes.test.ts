// v2.7.0 item 1/8: a route overrides which agent runs a stage for one issue
// type, and the type list is config-driven, not fixed at the five defaults.
// The structural test: whatever routes and TYPE_LABELS name, every (type,
// stage) pair resolves to a real agent, so a typo in config.json fails at
// boot, not mid-run on some future issue that happens to hit the gap.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { resolveAgent, resolveRoute } from "../src/agents/executor";
import { configProblems, DEFAULT_CONFIG, loadConfig, mergeConfig, type FactoryConfig } from "../src/config";
import { issueType, labelsFor, TYPE_LABELS, typesFor } from "../src/labels";

const STAGES: readonly (keyof FactoryConfig["stages"] & string)[] = ["triage", "plan", "build", "verify", "pr"];

describe("resolveRoute", () => {
  const agents = {
    opus: { preset: "claude", model: "opus" },
    sonnet: { preset: "claude", model: "sonnet" },
    haiku: { preset: "claude", model: "haiku" },
  };
  const stages = { default: "sonnet", triage: "haiku" };
  const routes = { docs: { stages: { build: "haiku" } } };

  test("a route's stage agent wins over the repo-wide stage agent", () => {
    expect(resolveRoute(agents, stages, routes, "build", "docs").name).toBe("haiku");
  });

  test("falls back to the repo-wide stage agent when the route has none for this stage", () => {
    expect(resolveRoute(agents, stages, routes, "verify", "docs").name).toBe("sonnet");
  });

  test("falls back to stages.default when neither the route nor the stage names an agent", () => {
    expect(resolveRoute(agents, stages, routes, "pr", "docs").name).toBe("sonnet");
  });

  test('falls back to "claude" when nothing names an agent and there is no default', () => {
    expect(resolveRoute({ claude: { preset: "claude" } }, {}, undefined, "pr", undefined).name).toBe("claude");
  });

  test("triage never routes on type, even when a route names a triage agent", () => {
    const withTriageRoute = { docs: { stages: { triage: "opus", build: "haiku" } } };
    expect(resolveRoute(agents, stages, withTriageRoute, "triage", "docs").name).toBe("haiku"); // stages.triage, not the route
  });

  test("an unrouted type behaves exactly like resolveAgent", () => {
    expect(resolveRoute(agents, stages, routes, "verify", "bug").name).toBe(
      resolveAgent(agents, stages, "verify").name,
    );
  });

  test("every type in routes and TYPE_LABELS, crossed with every stage, resolves to a defined agent", () => {
    const config = mergeConfig({
      repo: "a/b",
      agents,
      stages: { default: "sonnet", triage: "haiku", plan: "opus", build: "sonnet", verify: "sonnet", pr: "haiku" },
      routes,
    });
    for (const type of typesFor(config.routes)) {
      for (const stage of STAGES) {
        expect(() => resolveRoute(config.agents, config.stages, config.routes, stage, type)).not.toThrow();
      }
    }
  });

  test("the shipped example config resolves every (type, stage) pair", () => {
    const example = JSON.parse(readFileSync(join(import.meta.dir, "../template/.factory/config.example.json"), "utf8"));
    const config = mergeConfig({ ...example, repo: "a/b" });
    for (const type of typesFor(config.routes)) {
      for (const stage of STAGES) {
        expect(() => resolveRoute(config.agents, config.stages, config.routes, stage, type)).not.toThrow();
      }
    }
  });
});

describe("config validation of routes", () => {
  test("a route naming an agent outside config.agents is refused", () => {
    const problems = configProblems({
      ...DEFAULT_CONFIG,
      repo: "a/b",
      agents: { claude: { preset: "claude" } },
      routes: { docs: { stages: { build: "ghost" } } },
    });
    expect(problems).toContain('routes.docs.stages.build: "ghost" is not an agent in config.agents');
  });

  test("a route naming triage is refused: triage never routes on type", () => {
    const problems = configProblems({
      ...DEFAULT_CONFIG,
      repo: "a/b",
      routes: { docs: { stages: { triage: "claude" } } },
    });
    expect(problems).toContain("routes.docs.stages.triage: unknown stage (allowed: plan, build, verify, pr, retro)");
  });

  test('proof must be "test" or "check"', () => {
    const problems = configProblems({ ...DEFAULT_CONFIG, repo: "a/b", routes: { content: { proof: "vibes" } } });
    expect(problems).toContain('routes.content.proof: expected "test" or "check", got "vibes"');
  });

  test("a well-formed routes block validates cleanly", () => {
    const problems = configProblems({
      ...DEFAULT_CONFIG,
      repo: "a/b",
      agents: { claude: { preset: "claude" }, haiku: { preset: "claude", model: "haiku" } },
      routes: { docs: { stages: { build: "haiku" }, skills: ["writing"], proof: "check" } },
    });
    expect(problems).toEqual([]);
  });
});

describe("loadConfig checks every routed skill exists on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-routes-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function repoWith(config: object): string {
    const d = mkdtempSync(join(dir, "r-"));
    mkdirSync(join(d, ".factory"));
    writeFileSync(join(d, ".factory/config.json"), JSON.stringify(config));
    return d;
  }

  test("a route naming a skill with no SKILL.md on disk is refused at boot, not left to no-op mid-run", async () => {
    const target = repoWith({ repo: "a/b", routes: { docs: { skills: ["writing"] } } });
    await expect(loadConfig(target)).rejects.toThrow(
      /routes\.docs\.skills: "writing" \(\.claude\/skills\/writing\/SKILL\.md not found\)/,
    );
  });

  test("a route naming a skill that is on disk loads cleanly", async () => {
    const target = repoWith({ repo: "a/b", routes: { docs: { skills: ["writing"] } } });
    mkdirSync(join(target, ".claude/skills/writing"), { recursive: true });
    writeFileSync(join(target, ".claude/skills/writing/SKILL.md"), "---\nname: writing\n---\nWrite in plain language.");
    const config = await loadConfig(target);
    expect(config.routes.docs?.skills).toEqual(["writing"]);
  });
});

describe("typesFor / issueType", () => {
  test("with no routes, the type list is exactly the five defaults", () => {
    expect(typesFor(undefined)).toEqual([...TYPE_LABELS]);
  });

  test("a route key not already in TYPE_LABELS extends the type list", () => {
    expect(typesFor({ content: {} })).toEqual([...TYPE_LABELS, "content"]);
  });

  test("a route key already in TYPE_LABELS does not duplicate it", () => {
    expect(typesFor({ docs: {} })).toEqual([...TYPE_LABELS]);
  });

  test("issueType picks the one label that is in the type list", () => {
    expect(issueType({ content: {} }, ["factory:ready", "content", "factory:triaging"])).toBe("content");
  });

  test("issueType is undefined when no label is a known type", () => {
    expect(issueType(undefined, ["factory:ready"])).toBeUndefined();
  });
});

describe("labelsFor", () => {
  test("with no routes, labelsFor is exactly LABELS", () => {
    expect(
      labelsFor(undefined)
        .map((l) => l.name)
        .sort(),
    ).toEqual(
      labelsFor({})
        .map((l) => l.name)
        .sort(),
    );
  });

  test("a repo-added type gets one extra label doctor can create", () => {
    const names = labelsFor({ content: {} }).map((l) => l.name);
    expect(names).toContain("content");
  });

  test("a route reusing an existing type name never duplicates its label", () => {
    const names = labelsFor({ docs: {} }).map((l) => l.name);
    expect(names.filter((n) => n === "docs")).toHaveLength(1);
  });
});
