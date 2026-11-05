// Layers for workflow, autonomy, model and budget: the nearest level wins unless the org locked the
// value; a team routes by label or changed path; `config explain` names the level; the dashboard filters by team.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigExplained } from "../src/config";
import { explainKey } from "../src/team/explain";
import { resolveTeam } from "../src/team/resolve";
import { routeTeam } from "../src/team/route";
import { teamProblems } from "../src/team/schema";

const get = (v: unknown, path: string) =>
  path.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown> | undefined)?.[k], v);

describe("nearest level wins", () => {
  test("workflow, autonomy and model take the nearest level's value", () => {
    const r = resolveTeam({
      builtin: { workflow: "default" },
      org: { name: "o", workflow: "org-flow", autonomy: "supervised", model: "m-org" } as never,
      team: { name: "t", autonomy: "semi", model: "m-team" } as never,
      repo: { workflow: "repo-flow", autonomy: "full" },
    });
    expect(r.values.workflow).toBe("repo-flow");
    expect(r.values.autonomy).toBe("full");
    expect(r.values.model).toBe("m-team");
    expect(r.origin.workflow).toBe("repo");
    expect(r.origin.model).toBe("team");
  });

  test("a budget and a model list set lower down apply while the org leaves them unlocked", () => {
    const r = resolveTeam({
      builtin: {},
      org: { name: "o", policy: { budget_usd_month: 500, models: ["a", "b", "c"] } },
      team: { name: "t", policy: { budget_usd_month: 200, models: ["a", "b"] } },
      repo: { policy: { budget_usd_month: 100, models: ["a"] } },
    });
    expect(get(r.values, "policy.budget_usd_month")).toBe(100);
    expect(get(r.values, "policy.models")).toEqual(["a"]);
  });
});

describe("an org lock", () => {
  const org = {
    name: "o",
    workflow: "org-flow",
    autonomy: "supervised",
    model: "m-org",
    policy: { budget_usd_month: 500, models: ["a", "b"] },
    locked: ["workflow", "autonomy", "model", "budget_usd_month", "models"],
  };
  const lower = {
    workflow: "mine",
    autonomy: "full",
    model: "m-mine",
    policy: { budget_usd_month: 50, models: ["a"] },
  };

  test("a repo cannot change a locked org value, loosening or not", () => {
    const r = resolveTeam({ builtin: {}, org: org as never, repo: lower });
    expect(r.values.workflow).toBe("org-flow");
    expect(r.values.autonomy).toBe("supervised");
    expect(r.values.model).toBe("m-org");
    expect(get(r.values, "policy.budget_usd_month")).toBe(500);
    expect(get(r.values, "policy.models")).toEqual(["a", "b"]);
    expect(r.origin.autonomy).toBe("org");
    for (const key of ["workflow", "autonomy", "model", "budget_usd_month", "models"])
      expect(r.problems.some((p) => p.includes("locked") && p.includes(key))).toBe(true);
  });

  test("a team cannot change a locked org value either", () => {
    const r = resolveTeam({ builtin: {}, org: org as never, team: { name: "t", ...lower } as never });
    expect(r.values.autonomy).toBe("supervised");
    expect(get(r.values, "policy.budget_usd_month")).toBe(500);
  });

  test("a lower level may repeat the locked value without a problem", () => {
    const r = resolveTeam({ builtin: {}, org: org as never, repo: { autonomy: "supervised" } });
    expect(r.problems).toEqual([]);
  });

  test("a lock on a value the org never set pins nothing", () => {
    const r = resolveTeam({ builtin: {}, org: { name: "o", locked: ["autonomy"] }, repo: { autonomy: "semi" } });
    expect(r.values.autonomy).toBe("semi");
    expect(r.problems).toEqual([]);
  });
});

describe("autonomy in a team file", () => {
  test("must be supervised, semi or full", () => {
    expect(teamProblems({ name: "t", autonomy: "wild" }, "team")).toEqual([
      'autonomy must be supervised, semi or full, got "wild".',
    ]);
    expect(teamProblems({ name: "o", autonomy: "semi" }, "org")).toEqual([]);
  });
});

describe("routing an issue to a team", () => {
  const teams = [
    { name: "web", repos: ["acme/mono"], owns: { labels: ["area:web"], paths: ["apps/web/**"] } },
    { name: "api", repos: ["acme/mono"], owns: { paths: ["services/api/**"] } },
    { name: "rest", repos: ["acme/mono"] },
    { name: "other", repos: ["acme/else"], owns: { labels: ["area:web"] } },
  ];
  test("a label picks the team that owns it", () => {
    expect(routeTeam(teams, "acme/mono", { labels: ["area:web"], paths: [] })).toEqual({ team: "web", by: "label" });
  });
  test("a changed path picks the team that owns it", () => {
    expect(routeTeam(teams, "acme/mono", { labels: [], paths: ["services/api/x/y.ts"] })).toEqual({
      team: "api",
      by: "path",
    });
  });
  test("a label beats a path", () => {
    expect(routeTeam(teams, "acme/mono", { labels: ["area:web"], paths: ["services/api/a.ts"] })?.team).toBe("web");
  });
  test("an issue that matches no owner goes to the repo's team with no owns", () => {
    expect(routeTeam(teams, "acme/mono", { labels: ["bug"], paths: ["README.md"] })).toEqual({
      team: "rest",
      by: "default",
    });
  });
  test("a team in another repo is never chosen", () => {
    expect(routeTeam(teams, "acme/else", { labels: ["area:web"], paths: [] })?.team).toBe("other");
    expect(routeTeam(teams, "acme/none", { labels: ["area:web"], paths: [] }) ?? "no team").toBe("no team");
  });
});

describe("config explain", () => {
  test("names the level, and the org lock that held the value", () => {
    const applied = resolveTeam({
      builtin: {},
      org: { name: "o", autonomy: "supervised", locked: ["autonomy"] } as never,
      repo: { autonomy: "full" },
    });
    const lines = explainKey("autonomy", applied, ["autonomy"]);
    expect(lines).toEqual(['autonomy = "supervised" (org)', "locked by the org"]);
  });
  test("budget_usd_month is read as policy.budget_usd_month", () => {
    const applied = resolveTeam({ builtin: {}, repo: { policy: { budget_usd_month: 40 } } });
    expect(explainKey("budget_usd_month", applied, [])).toEqual(["policy.budget_usd_month = 40 (repo)"]);
  });
  test("an unset key says so", () => {
    expect(explainKey("autonomy", resolveTeam({ builtin: {} }), [])).toEqual(["autonomy is not set at any level."]);
  });
});

describe("loaded from files", () => {
  function repo(org: string, teams: Record<string, string>, config: Record<string, unknown> = {}): string {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "team-layers-"));
    mkdirSync(join(dir, ".factory", "team", "teams"), { recursive: true });
    writeFileSync(join(dir, ".factory", "config.json"), JSON.stringify({ repo: "acme/mono", ...config }));
    writeFileSync(join(dir, ".factory", "team", "org.yml"), org);
    for (const [n, y] of Object.entries(teams)) writeFileSync(join(dir, ".factory", "team", "teams", `${n}.yml`), y);
    return dir;
  }

  test("the resolved autonomy reaches the config, and an org lock beats the repo's merge.autonomy", async () => {
    const open = repo(
      "name: o\nautonomy: semi\n",
      { a: "name: a\nrepos: [acme/mono]\n" },
      { merge: { autonomy: "full" } },
    );
    expect((await loadConfigExplained(open)).config.merge.autonomy).toBe("full");
    const locked = repo(
      "name: o\nautonomy: supervised\nlocked: [autonomy]\n",
      { a: "name: a\nrepos: [acme/mono]\n" },
      { merge: { autonomy: "full" } },
    );
    const applied = await loadConfigExplained(locked);
    expect(applied.config.merge.autonomy).toBe("supervised");
    expect(applied.locked).toEqual(["autonomy"]);
  });

  test("two teams on one repo are routed by the issue's label or path, and a named team wins", async () => {
    const dir = repo("name: o\n", {
      web: "name: web\nrepos: [acme/mono]\nowns: { labels: [area:web] }\nworkflow: web-flow\n",
      api: "name: api\nrepos: [acme/mono]\nowns: { paths: ['svc/**'] }\nworkflow: api-flow\n",
    });
    expect((await loadConfigExplained(dir)).team ?? "no team").toBe("no team");
    const web = await loadConfigExplained(dir, { issue: { labels: ["area:web"], paths: [] } });
    expect([web.team, web.config.workflow]).toEqual(["web", "web-flow"]);
    const api = await loadConfigExplained(dir, { issue: { labels: [], paths: ["svc/a.ts"] } });
    expect(api.team).toBe("api");
    expect((await loadConfigExplained(dir, { team: "api" })).team).toBe("api");
  });
});
