// The team files load, and a bad one is refused with a sentence that names the key.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrg, loadTeam, loadTeams } from "../src/team/load";
import { teamProblems } from "../src/team/schema";

const fixture = join(import.meta.dir, "fixtures/team/acme");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "team-load-"));
  dirs.push(dir);
  mkdirSync(join(dir, "teams"));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

describe("team load", () => {
  test("the fixtures load", () => {
    const org = loadOrg(fixture);
    expect(org.ok && org.value.policy?.models).toEqual(["haiku", "sonnet"]);
    expect(org.ok && org.value.locked).toEqual(["review", "merge"]);
    const teams = loadTeams(fixture);
    expect(teams.ok && teams.value.map((t) => t.name)).toEqual(["core", "site"]);
    const core = loadTeam(fixture, "core");
    expect(core.ok && core.value.roles?.build).toEqual({ harness: "claude-cloud", model: "sonnet" });
    const site = loadTeam(fixture, "site");
    expect(site.ok && site.value.source?.kind).toBe("plane");
  });

  test("a bad risk word names the key", () => {
    expect(teamProblems({ name: "x", policy: { risk_max: "extreme" } }, "team")).toEqual([
      'policy.risk_max must be low, medium or high, got "extreme".',
    ]);
  });

  test("a missing name is a problem", () => {
    expect(teamProblems({ mission: "m" }, "team")).toEqual(["name is required and must be a non-empty string."]);
  });

  test("a name that differs from the file name is a problem", () => {
    const dir = repoWith({ "teams/core.yml": "name: other\n" });
    const r = loadTeams(dir);
    expect(r).toEqual({ ok: false, problems: ['teams/core.yml: name is "other" but the file is named core.'] });
  });

  test("a problem in a file carries the file label, and bad YAML does not throw", () => {
    const dir = repoWith({ "org.yml": "name: acme\npolicy:\n  budget_usd_month: lots\n", "teams/a.yml": "name: [\n" });
    const org = loadOrg(dir);
    expect(org.ok ? [] : org.problems).toEqual(["org.yml: policy.budget_usd_month must be a number."]);
    const teams = loadTeams(dir);
    expect(teams.ok).toBe(false);
    expect(teamProblems("nope", "org")).toEqual(["The org file must be a mapping with a name."]);
  });

  test("a missing org.yml is valid and sets no policy", () => {
    const org = loadOrg(repoWith({}));
    expect(org.ok && org.value.policy).toBeUndefined();
  });

  test("an unknown team is a problem", () => {
    const r = loadTeam(fixture, "nope");
    expect(r.ok).toBe(false);
  });
});
