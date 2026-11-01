// An approver's always-allow plans a team-file change, and the org ceiling and approver list bound it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planAlwaysAllow, planFromDir } from "../src/team/always-allow";
import type { OrgFile, TeamFile } from "../src/team/schema";

const org: OrgFile = { name: "o", locked: ["review"] };
const team: TeamFile = { name: "t", approvers: ["ann"], roles: { build: { tools: ["Bash(ls)"] } } };
const ask = (over: Partial<Parameters<typeof planAlwaysAllow>[0]> = {}) =>
  planAlwaysAllow({ org, team, approver: "ann", role: "build", rule: "Bash(bun test)", ...over });

describe("always-allow plan", () => {
  test("an approver's rule is appended to the role's tools in the team file", () => {
    const plan = ask();
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.path).toBe(".factory/team/teams/t.yml");
    expect(Bun.YAML.parse(plan.content)).toEqual({
      name: "t",
      approvers: ["ann"],
      roles: { build: { tools: ["Bash(ls)", "Bash(bun test)"] } },
    });
    expect(plan.branch).toBe("factory/always-allow-t-build-bash-bun-test");
    expect(plan.title).toBe("Always allow Bash(bun test) for build in t");
  });

  test("someone who is not an approver is refused", () => {
    expect(ask({ approver: "bob" })).toEqual({
      ok: false,
      reason: "bob is not an approver of team t, so the rule is not added.",
    });
  });

  test("a role the org locked is refused", () => {
    expect(ask({ role: "review" })).toEqual({
      ok: false,
      reason: "The org locked role review; a team cannot change its tools.",
    });
  });

  test("a blanket rule is refused", () => {
    expect(ask({ rule: "*" })).toEqual({
      ok: false,
      reason: '"*" allows everything; always-allow needs a narrow rule.',
    });
  });

  test("a rule the role already has is refused", () => {
    expect(ask({ rule: "Bash(ls)" })).toEqual({ ok: false, reason: "Role build already allows Bash(ls)." });
  });

  test("planFromDir reads the org file and refuses when it is broken", () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "aa-"));
    writeFileSync(join(dir, "org.yml"), "locked: [build]\n");
    const plan = planFromDir(dir, team, "ann", "build", "Bash(bun test)");
    expect(plan).toEqual({ ok: false, reason: "org.yml: name is required and must be a non-empty string." });
  });
});
