import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configProblems, mergeConfig } from "../src/config";
import {
  DEFAULT_ORCHESTRATE,
  orchestrateActive,
  orchestrateOf,
  orchestrateProblems,
  resolveOrchestrate,
} from "../src/orchestrate/config";
import { applyTeam } from "../src/team/apply";

const root = join(import.meta.dir, "..");

describe("orchestrate config", () => {
  test("defaults", () => {
    const r = resolveOrchestrate({});
    expect(r.value).toEqual(DEFAULT_ORCHESTRATE);
    expect(orchestrateOf({}).providers["cursor-cloud"]?.max).toBe(4);
    expect(new Set(Object.values(r.origin))).toEqual(new Set(["builtin"]));
  });

  test("lowest wins", () => {
    const r = resolveOrchestrate({
      org: { providers: { "cursor-cloud": { max: 2 } } },
      repo: { providers: { "cursor-cloud": { max: 4 } } },
    });
    const cc = r.value.providers["cursor-cloud"];
    if (cc === undefined) throw new Error("expected cursor-cloud provider");
    expect(cc.max).toBe(2);
    expect(r.problems.length).toBe(1);
    expect(r.origin["providers.cursor-cloud.max"]).toBe("org");
  });

  test("stricter enabled", () => {
    const r = resolveOrchestrate({ org: { enabled: false }, repo: { enabled: true } });
    expect(r.value.enabled).toBe(false);
    expect(r.problems.length).toBe(1);
  });

  test("fast refused", () => {
    expect(orchestrateProblems({ providers: { "cursor-cloud": { model: "x-fast" } } }, "orchestrate").length).toBe(1);
  });

  test("policyModels refusal", () => {
    const r = resolveOrchestrate({
      org: { providers: { "cursor-cloud": { model: "sonnet" } } },
      repo: { providers: { "cursor-cloud": { model: "opus" } } },
      policyModels: ["sonnet", "haiku"],
    });
    const cc = r.value.providers["cursor-cloud"];
    if (cc === undefined) throw new Error("expected cursor-cloud provider");
    expect(cc.model).toBe("sonnet");
    expect(r.problems.length).toBe(1);
  });

  test("{prompt} refusal", () => {
    const p = orchestrateProblems({ providers: { "cursor-cloud": { launch: ["run {prompt}"] } } }, "orchestrate");
    expect(p.length).toBe(1);
  });

  test("intake above day refusal", () => {
    const p = orchestrateProblems({ cost: { perDayUsd: 10, intakeStopUsd: 20 } }, "orchestrate");
    expect(p.length).toBe(1);
  });

  test("locked roles", () => {
    const r = resolveOrchestrate({
      org: { roles: { build: ["local"] } },
      repo: { roles: { build: ["cursor-cloud"] } },
      locked: ["orchestrate.roles"],
    });
    expect(r.value.roles.build).toEqual(["local"]);
    expect(r.problems.some((x) => x.includes("orchestrate.roles"))).toBe(true);
  });

  test("named roles at repo", () => {
    const r = resolveOrchestrate({ repo: { roles: { build: ["local"] } } });
    expect(r.value.roles.build).toEqual(["local"]);
    expect(r.origin["roles.build"]).toBe("repo");
  });

  test("config path", () => {
    const problems = configProblems({ repo: "a/b", gates: [], orchestrate: { bogus: 1 } });
    expect(problems.some((p) => p.includes("bogus"))).toBe(true);
  });

  test("team apply", () => {
    mkdirSync(tmpdir(), { recursive: true });
    const fixture = join(root, "tests/fixtures/team-repo");
    const dir = mkdtempSync(join(tmpdir(), "orch-team-"));
    cpSync(fixture, dir, { recursive: true });
    writeFileSync(
      join(dir, ".factory", "team", "org.yml"),
      "name: acme\norchestrate:\n  providers:\n    cursor-cloud:\n      max: 2\n",
    );
    const raw = {
      repo: "acme/core-api",
      gates: [],
      orchestrate: { providers: { "cursor-cloud": { max: 4 } } },
    };
    const config = mergeConfig(raw);
    const applied = applyTeam({
      repoDir: dir,
      config,
      defaults: mergeConfig({ profile: config.profile }),
      raw,
      check: configProblems,
    });
    expect(applied.team).toBe("core");
    expect(applied.config.orchestrate?.providers?.["cursor-cloud"]?.max).toBe(2);
    expect(applied.resolved.origin["orchestrate.providers.cursor-cloud.max"]).toBe("org");
  });

  test("toggle is a ceiling", () => {
    expect(orchestrateActive({ getToggle: () => true }, {})).toBe(false);
    expect(orchestrateActive({ getToggle: () => false }, { orchestrate: { enabled: true } })).toBe(false);
  });
});
