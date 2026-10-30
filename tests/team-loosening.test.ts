// A team may only tighten what its org set: every fixture team resolves no looser than its org.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { dirname, join } from "node:path";
import { loadOrg, loadTeams } from "../src/team/load";
import { RISKS } from "../src/team/schema";
import { resolveTeam } from "../src/team/resolve";

const root = join(import.meta.dir, "fixtures/team");
const orgDirs = [...new Glob("**/teams/*.yml").scanSync(root)].map((f) => join(root, dirname(dirname(f))));
const dirs = [...new Set(orgDirs)];

describe("team loosening", () => {
  test("the walk finds the fixture teams", () => {
    expect(orgDirs.length).toBeGreaterThanOrEqual(2);
  });

  for (const dir of dirs) {
    const org = loadOrg(dir);
    const teams = loadTeams(dir);
    if (!org.ok || !teams.ok) throw new Error(`${dir} does not load`);
    for (const team of teams.value) {
      test(`${dir.slice(root.length + 1)}/${team.name} resolves no looser than its org`, () => {
        const ceiling = org.value.policy ?? {};
        const { values, problems } = resolveTeam({ builtin: {}, org: org.value, team });
        const p = (values.policy ?? {}) as NonNullable<typeof ceiling>;
        expect(problems).toEqual([]);
        if (ceiling.auto_merge?.allowed === false) expect(p.auto_merge?.allowed).toBe(false);
        if (ceiling.approvals?.requester_cannot_approve) expect(p.approvals?.requester_cannot_approve).toBe(true);
        if (ceiling.budget_usd_month !== undefined)
          expect(p.budget_usd_month).toBeLessThanOrEqual(ceiling.budget_usd_month);
        if (ceiling.risk_max)
          expect(RISKS.indexOf(p.risk_max ?? "high")).toBeLessThanOrEqual(RISKS.indexOf(ceiling.risk_max));
        for (const m of p.models ?? []) expect(ceiling.models ?? [m]).toContain(m);
      });
    }
  }

  test("a team setting auto_merge.allowed true under an org false resolves to false", () => {
    const r = resolveTeam({
      builtin: {},
      org: { name: "o", policy: { auto_merge: { allowed: false } } },
      team: { name: "t", policy: { auto_merge: { allowed: true } } },
    });
    expect((r.values.policy as { auto_merge: { allowed: boolean } }).auto_merge.allowed).toBe(false);
  });
});
