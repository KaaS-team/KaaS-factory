// Hard-deny rules cannot be lifted by approval, workflow or team; soft-deny rules can, by a named
// approver. The walk loads every team file under the fixtures and .factory/team and fails when one overrides a hard-deny rule.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfigExplained } from "../src/config";
import { explainLines } from "../src/team/explain";
import { loadOrg, loadTeams } from "../src/team/load";
import { resolveTeam } from "../src/team/resolve";
import { type OrgFile, type TeamFile, teamProblems } from "../src/team/schema";

const root = join(import.meta.dir, "..");
const policyOf = (r: ReturnType<typeof resolveTeam>) =>
  r.values.policy as { auto_merge: { allowed: boolean }; risk_max: string };
const org: OrgFile = {
  name: "o",
  policy: { auto_merge: { allowed: false }, risk_max: "low", deny: { "auto_merge.allowed": "hard", risk_max: "soft" } },
};

// Every problem a team file raises against its org's hard-deny rules; the structural walk and the unit tests share it.
function hardDenyOverrides(o: OrgFile, team: TeamFile): string[] {
  const hard = Object.entries(o.policy?.deny ?? {}).filter(([, k]) => k === "hard");
  const r = resolveTeam({ builtin: {}, org: o, team });
  return r.problems.filter((p) => hard.some(([rule]) => p.includes(`policy.${rule}`)));
}

describe("hard-deny and soft-deny", () => {
  test("a team cannot loosen a hard-deny rule", () => {
    const team: TeamFile = { name: "t", policy: { auto_merge: { allowed: true } } };
    const r = resolveTeam({ builtin: {}, org, team });
    expect(policyOf(r).auto_merge.allowed).toBe(false);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toContain("hard-deny");
    expect(hardDenyOverrides(org, team).length).toBe(1);
  });

  test("a pre-approval by a named approver cannot lift a hard-deny rule", () => {
    const team: TeamFile = {
      name: "t",
      approvers: ["alice"],
      policy: { auto_merge: { allowed: true }, preapprove: { "auto_merge.allowed": "alice" } },
    };
    const r = resolveTeam({ builtin: {}, org, team });
    expect(policyOf(r).auto_merge.allowed).toBe(false);
    expect(r.lifted).toEqual({});
    expect(r.problems.some((p) => p.includes("approval cannot lift it"))).toBe(true);
  });

  test("a repo override cannot lift a hard-deny rule", () => {
    const r = resolveTeam({ builtin: {}, org, repo: { policy: { auto_merge: { allowed: true } } } });
    expect(policyOf(r).auto_merge.allowed).toBe(false);
    expect(r.problems[0]).toContain("hard-deny");
  });

  test("a workflow carrying a policy block does not change the policy", () => {
    const team: TeamFile = { name: "t", workflows: { ship: { policy: { auto_merge: { allowed: true } } } } };
    const r = resolveTeam({ builtin: {}, org, team });
    expect(policyOf(r).auto_merge.allowed).toBe(false);
  });

  test("a soft-deny rule is lifted by an approver the team lists", () => {
    const team: TeamFile = {
      name: "t",
      approvers: ["alice"],
      policy: { risk_max: "high", preapprove: { risk_max: "alice" } },
    };
    const r = resolveTeam({ builtin: {}, org, team });
    expect(policyOf(r).risk_max).toBe("high");
    expect(r.lifted).toEqual({ risk_max: "alice" });
    expect(r.problems).toEqual([]);
  });

  test("a soft-deny rule loosened with no named approver stays strict and says soft-deny", () => {
    const r = resolveTeam({ builtin: {}, org, team: { name: "t", policy: { risk_max: "high" } } });
    expect(policyOf(r).risk_max).toBe("low");
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toContain("soft-deny");
  });

  test("an approver who is not on the team's list lifts nothing", () => {
    const team: TeamFile = {
      name: "t",
      approvers: ["bob"],
      policy: { risk_max: "high", preapprove: { risk_max: "alice" } },
    };
    const r = resolveTeam({ builtin: {}, org, team });
    expect(policyOf(r).risk_max).toBe("low");
    expect(r.problems.some((p) => p.includes("not one of its approvers"))).toBe(true);
  });

  test("a rule the org did not mark cannot be pre-approved", () => {
    const team: TeamFile = { name: "t", approvers: ["alice"], policy: { preapprove: { budget_usd_month: "alice" } } };
    const r = resolveTeam({ builtin: {}, org, team });
    expect(r.problems[0]).toContain("did not mark soft-deny");
  });

  test("the schema keeps deny in the org file and preapprove in a team file", () => {
    expect(teamProblems({ name: "t", policy: { deny: { risk_max: "hard" } } }, "team")).toEqual([
      "policy.deny is only valid in the org file.",
    ]);
    expect(teamProblems({ name: "o", policy: { preapprove: { risk_max: "a" } } }, "org")).toEqual([
      "policy.preapprove is only valid in the team file.",
    ]);
    expect(teamProblems({ name: "o", policy: { deny: { risk_max: "firm", nope: "hard" } } }, "org").length).toBe(2);
  });
});

describe("factory explain names the deny kind", () => {
  test("a blocked hard-deny rule and a lifted soft-deny rule both show their kind", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "team-deny-"));
    cpSync(join(root, "tests/fixtures/team-repo"), dir, { recursive: true });
    cpSync(join(root, "tests/fixtures/team-deny/.factory/team"), join(dir, ".factory/team"), { recursive: true });
    const lines = explainLines({ issue: 3, repo: "acme/core-api", applied: await loadConfigExplained(dir) });
    expect(lines).toContain("deny policy.auto_merge.allowed: hard-deny");
    expect(lines).toContain("deny policy.risk_max: soft-deny, lifted by alice");
    expect(lines).toContain('policy.risk_max = "medium" (team)');
  });
});

describe("structural: no team file overrides a hard-deny rule", () => {
  const dirs = [
    ...new Set(
      [...new Glob("**/teams/*.yml").scanSync({ cwd: join(root, "tests/fixtures"), dot: true })].map((f) =>
        join(root, "tests/fixtures", dirname(dirname(f))),
      ),
    ),
  ];
  const hardOrgs = dirs.filter((d) => {
    const o = loadOrg(d);
    return o.ok && Object.values(o.value.policy?.deny ?? {}).includes("hard");
  });

  test("the walk finds an org with a hard-deny rule", () => {
    expect(hardOrgs.length > 0).toBe(true);
  });

  for (const dir of dirs) {
    const o = loadOrg(dir);
    const teams = loadTeams(dir);
    if (!o.ok || !teams.ok) throw new Error(`${dir} does not load`);
    for (const team of teams.value) {
      test(`${dir.slice(root.length + 1)}/${team.name} overrides no hard-deny rule`, () => {
        expect(hardDenyOverrides(o.value, team)).toEqual([]);
      });
    }
  }
});
