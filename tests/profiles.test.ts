// Autonomy profiles: one resolver (mergeConfig) layers DEFAULT_CONFIG, the
// profile, then the repo's own keys; the bundled plan gate reads the result.

import { describe, expect, test } from "bun:test";
import { configProblems, DEFAULT_CONFIG, mergeConfig, PROFILES, type FactoryConfig, type Profile } from "../src/config";
import { evalExpr } from "../src/core/expr";
import { defaultWorkflow } from "../src/engine/workflows";

// The bundled workflow's own plan -> build condition, not a copy of it.
const autoApprove = defaultWorkflow().steps.plan!.next[0]!;
const skipsGate = (
  config: FactoryConfig,
  risk: string,
  eligible = true,
  toggle = config.riskPolicy.autoApproveLowRisk,
) =>
  Boolean(
    evalExpr(autoApprove.if!, {
      plan: { risk, autoApproveEligible: eligible },
      toggles: { autoApproveLowRisk: toggle },
      config,
    }),
  );

describe("profile defaults", () => {
  test("no profile is the team behaviour the factory always had", () => {
    const none = mergeConfig({ repo: "a/b" });
    const team = mergeConfig({ repo: "a/b", profile: "team" });
    expect(none.riskPolicy).toEqual(team.riskPolicy);
    expect(none.merge.policy).toBe("off");
    expect(none.maxOpenFactoryPrs).toBe(DEFAULT_CONFIG.maxOpenFactoryPrs);
  });

  test.each([
    ["solo", 3, "auto"],
    ["team", 5, "off"],
    ["startup", 10, "off"],
    ["scaleup", 10, "off"],
    ["enterprise", 10, "off"],
  ] as const)("%s: %i open PRs, merge %s", (profile, prs, merge) => {
    const c = mergeConfig({ repo: "a/b", profile });
    expect(c.maxOpenFactoryPrs).toBe(prs);
    expect(c.merge.policy).toBe(merge);
  });

  test("a key the repo sets wins over its profile, field by field", () => {
    const c = mergeConfig({
      repo: "a/b",
      profile: "enterprise",
      maxOpenFactoryPrs: 2,
      riskPolicy: { autoApproveLowRisk: true } as FactoryConfig["riskPolicy"],
    });
    expect(c.maxOpenFactoryPrs).toBe(2);
    expect(c.riskPolicy.autoApproveLowRisk).toBe(true);
    expect(c.riskPolicy.autoApproveMaxRisk).toBe("low");
  });
});

describe("the bundled plan gate under each profile", () => {
  const cfg = (profile: Profile) => mergeConfig({ repo: "a/b", profile });

  test.each([
    ["solo", { low: true, medium: true, high: false }],
    ["team", { low: true, medium: false, high: false }],
    ["startup", { low: true, medium: false, high: false }],
    ["scaleup", { low: false, medium: false, high: false }],
    ["enterprise", { low: false, medium: false, high: false }],
  ] as const)("%s skips the plan gate for %o", (profile, want) => {
    for (const risk of ["low", "medium", "high"] as const)
      expect([risk, skipsGate(cfg(profile), risk)]).toEqual([risk, want[risk]]);
  });

  test("the planner's own 'not eligible' and the dashboard switch still stop it", () => {
    expect(skipsGate(cfg("solo"), "low", false)).toBe(false);
    expect(skipsGate(cfg("solo"), "low", true, false)).toBe(false);
  });
});

describe("profile validation", () => {
  test("names the bad profile and the bad ceiling", () => {
    const p = configProblems({ repo: "a/b", profile: "megacorp", riskPolicy: { autoApproveMaxRisk: "high" } }).join(
      "\n",
    );
    expect(p).toMatch(/profile: expected one of solo, team, startup, scaleup, enterprise/);
    expect(p).toMatch(/riskPolicy\.autoApproveMaxRisk: expected "low" or "medium"/);
  });
  test("every profile is accepted", () => {
    // enterprise also names a sandbox runtime (src/profile-rules.ts), which every profile accepts.
    const runtime = { gates: "docker", check: "docker" };
    for (const profile of Object.keys(PROFILES)) expect(configProblems({ repo: "a/b", profile, runtime })).toEqual([]);
  });
});
