// One case per resolution rule: local wins, strictest wins, lists intersect, roles replace by name,
// a locked name is refused, and no team and no org leaves the builtin alone.
import { describe, expect, test } from "bun:test";
import type { OrgFile, TeamFile } from "../src/team/schema";
import { resolveTeam, stricter } from "../src/team/resolve";

const builtin = {
  model: "sonnet",
  timeouts: { build: 30 },
  roles: { review: { model: "opus" }, build: { model: "haiku" } },
};
const get = (v: unknown, path: string) =>
  path.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown> | undefined)?.[k], v);

describe("team resolve", () => {
  test("rule 1: the most local level wins a preference", () => {
    const r = resolveTeam({
      builtin,
      org: { name: "o" },
      team: { name: "t", model: "haiku", timeouts: { build: 20 } },
      repo: { timeouts: { build: 10 } },
    });
    expect(r.values.model).toBe("haiku");
    expect(get(r.values, "timeouts.build")).toBe(10);
    expect(r.origin.model).toBe("team");
    expect(r.origin["timeouts.build"]).toBe("repo");
  });

  test("rule 2: the strictest policy value wins, whichever level holds it", () => {
    expect(stricter(true, false)).toBe(false);
    const org: OrgFile = {
      name: "o",
      policy: { auto_merge: { allowed: true, max_risk: "medium" }, risk_max: "high", budget_usd_month: 100 },
    };
    const team: TeamFile = {
      name: "t",
      policy: {
        auto_merge: { allowed: false, max_risk: "high" },
        risk_max: "low",
        budget_usd_month: 500,
        approvals: { requester_cannot_approve: true },
      },
    };
    const r = resolveTeam({
      builtin: {},
      org,
      team,
      repo: { policy: { budget_usd_month: 50, approvals: { requester_cannot_approve: false } } },
    });
    expect(get(r.values, "policy.auto_merge.allowed")).toBe(false);
    expect(get(r.values, "policy.auto_merge.max_risk")).toBe("medium");
    expect(get(r.values, "policy.risk_max")).toBe("low");
    expect(get(r.values, "policy.budget_usd_month")).toBe(50);
    expect(get(r.values, "policy.approvals.requester_cannot_approve")).toBe(true);
    expect(r.origin["policy.budget_usd_month"]).toBe("repo");
    expect(r.origin["policy.auto_merge.allowed"]).toBe("team");
  });

  test("rule 2: models and protected_paths intersect, and extend unions protected_paths only", () => {
    const org = { name: "o", policy: { models: ["haiku", "sonnet"], protected_paths: ["a/"] } };
    const team = { name: "t", policy: { models: ["sonnet", "opus"], protected_paths: ["a/", "b/"] } };
    const r = resolveTeam({ builtin: {}, org, team });
    expect(get(r.values, "policy.models")).toEqual(["sonnet"]);
    expect(get(r.values, "policy.protected_paths")).toEqual(["a/"]);
    const u = resolveTeam({ builtin: {}, org: { ...org, policy: { ...org.policy, extend: true } }, team });
    expect(get(u.values, "policy.protected_paths")).toEqual(["a/", "b/"]);
    expect(get(u.values, "policy.models")).toEqual(["sonnet"]);
  });

  test("rule 3: roles replace by name, as a whole", () => {
    const r = resolveTeam({ builtin, team: { name: "t", roles: { build: { harness: "claude-cloud" } } } });
    expect(get(r.values, "roles.build")).toEqual({ harness: "claude-cloud" });
    expect(r.origin["roles.build.harness"]).toBe("team");
    expect(r.origin["roles.build.model"]).toBeUndefined();
    expect(r.origin["roles.review.model"]).toBe("builtin");
  });

  test("rule 3: a locked name is refused with a problem naming the team", () => {
    const org = { name: "o", roles: { review: { model: "opus" } }, locked: ["review"] };
    const r = resolveTeam({ builtin, org, team: { name: "core", roles: { review: { model: "haiku" } } } });
    expect(get(r.values, "roles.review")).toEqual({ model: "opus" });
    expect(r.origin["roles.review.model"]).toBe("org");
    expect(r.problems).toEqual([
      "team core tried to replace roles.review, which the org locked; the org's version stays.",
    ]);
  });

  test("no team and no org is exactly the builtin, with only builtin origins", () => {
    const r = resolveTeam({ builtin, repo: undefined });
    expect(r.values).toEqual(builtin);
    expect(new Set(Object.values(r.origin))).toEqual(new Set(["builtin"]));
    expect(r.problems).toEqual([]);
  });
});
