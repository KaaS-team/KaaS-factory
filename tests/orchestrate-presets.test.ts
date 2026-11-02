import { describe, expect, test } from "bun:test";
import { DEFAULT_ORCHESTRATE, orchestrateOf, orchestrateProblems, resolveOrchestrate } from "../src/orchestrate/config";

describe("orchestrate presets", () => {
  test("split alone", () => {
    const r = resolveOrchestrate({ repo: { preset: "split" } });
    expect(r.value.providers["claude-cloud"]?.max).toBe(0);
    expect(r.value.providers["cursor-cloud"]?.max).toBe(4);
    expect(r.value.roles.build).toEqual(["cursor-cloud", "local"]);
    expect(r.origin["roles.build"]).toBe("repo");
  });

  test("all-claude alone", () => {
    const r = resolveOrchestrate({ repo: { preset: "all-claude" } });
    expect(r.value.providers["cursor-cloud"]?.max).toBe(0);
    expect(r.value.providers["claude-cloud"]?.max).toBe(0);
    expect(r.value.roles.build[0]).toBe("claude-cloud");
  });

  test("all-cursor alone", () => {
    const r = resolveOrchestrate({ repo: { preset: "all-cursor" } });
    expect(r.value.providers["claude-cloud"]?.max).toBe(0);
    expect(r.value.roles.groom).toBe("cursor-cloud");
    expect(r.value.groom.model).toBe("auto");
  });

  test("repo preset overrides org preset for roles", () => {
    const r = resolveOrchestrate({
      org: { preset: "all-cursor" },
      repo: { preset: "all-claude" },
    });
    expect(r.value.roles.build[0]).toBe("claude-cloud");
    expect(r.origin["roles.build"]).toBe("repo");
  });

  test("org max ceiling under repo preset", () => {
    const r = resolveOrchestrate({
      org: { providers: { "claude-cloud": { max: 0 } } },
      repo: { preset: "all-claude" },
    });
    expect(r.value.providers["claude-cloud"]?.max).toBe(0);
    expect(r.problems.length).toBe(1);
  });

  test("unknown preset refused", () => {
    const p = orchestrateProblems({ preset: "everything" }, "orchestrate");
    expect(p.length).toBe(1);
    expect(p[0]).toBe("orchestrate.preset: expected one of split, all-claude, all-cursor");
  });

  test("explicit field beats preset", () => {
    const r = resolveOrchestrate({ repo: { preset: "all-claude", roles: { build: ["local"] } } });
    expect(r.value.roles.build).toEqual(["local"]);
  });

  test("empty input unchanged", () => {
    const r = resolveOrchestrate({});
    expect(r.value).toEqual(DEFAULT_ORCHESTRATE);
    expect(orchestrateOf({})).toEqual(DEFAULT_ORCHESTRATE);
  });
});
