import { describe, expect, test } from "bun:test";
import { mergeConfig } from "../src/config";
import { intakeGate } from "../src/dispatch";
import { startOfMonthUtc, teamBudgetHit, teamBudgetItem, teamCapUsd } from "../src/team/budget";

const spentBy = (byRepo: Record<string, number>) => ({
  spendSummary: (repo: string, _since: string) => ({ costUsd: byRepo[repo] ?? 0, unreportedRuns: 0 }),
  getToggle: () => true,
});

const withTeam = (name: string, monthlyUsd: number, repos: string[]) =>
  mergeConfig({ repo: repos[0] ?? "a/one", spend: { team: { name, monthlyUsd, repos } } } as never);

describe("team monthly budget", () => {
  test("a team over its cap stops intake and the reason names the team", async () => {
    const config = withTeam("core", 100, ["a/one", "a/two"]);
    const state = spentBy({ "a/one": 60, "a/two": 45 });
    const reason = teamBudgetHit(state, config);
    expect(reason).toContain("team core");
    expect(reason).toContain("$105.00");
    const gate = await intakeGate({ state } as never, config, []);
    expect(gate.open).toBe(false);
    expect(gate.paused).toContain("team core");
  });

  test("a team under its cap keeps taking work", async () => {
    const config = withTeam("core", 100, ["a/one", "a/two"]);
    const state = spentBy({ "a/one": 40, "a/two": 10 });
    expect(teamBudgetHit(state, config)).toBe(undefined);
    expect((await intakeGate({ state } as never, config, [])).open).toBe(true);
  });

  test("another team's spend does not count against this team", () => {
    const config = withTeam("docs", 100, ["b/docs"]);
    expect(teamBudgetHit(spentBy({ "a/one": 5000, "b/docs": 1 }), config)).toBe(undefined);
  });

  test("a config with no team cap is never held", () => {
    expect(teamBudgetHit(spentBy({ "a/one": 5000 }), mergeConfig({ repo: "a/one" }))).toBe(undefined);
  });

  test("the inbox item carries the reason", () => {
    const item = teamBudgetItem("over", "core");
    expect(item.kind).toBe("budget");
    expect(item.ask).toBe("over");
  });

  test("the lower of the policy and team caps wins, and the month starts on the 1st UTC", () => {
    expect(teamCapUsd(200, 50)).toBe(50);
    expect(teamCapUsd(undefined, 80)).toBe(80);
    expect(teamCapUsd()).toBe(undefined);
    expect(startOfMonthUtc(new Date("2026-11-17T10:00:00Z"))).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("team file to config", () => {
  test("budget_usd_month reaches the config as the team's monthly cap, scoped to its repos", async () => {
    const { cpSync, mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadConfig } = await import("../src/config");
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "team-budget-"));
    cpSync(join(import.meta.dir, "fixtures/team-repo"), dir, { recursive: true });
    const file = join(dir, ".factory/team/teams/core.yml");
    const { readFileSync } = await import("node:fs");
    writeFileSync(file, `${readFileSync(file, "utf8")}budget_usd_month: 75\n`);
    const config = await loadConfig(dir);
    expect(config.spend.team).toEqual({ name: "core", monthlyUsd: 75, repos: ["acme/core-api"] });
  });
});
