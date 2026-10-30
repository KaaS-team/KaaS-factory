import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, configProblems, loadConfig, loadConfigExplained, mergeConfig } from "../src/config";
import { applyTeam } from "../src/team/apply";

const root = join(import.meta.dir, "..");

function copyTo(from: string): string {
  const dir = mkdtempSync(join(tmpdir(), "team-wiring-"));
  cpSync(from, dir, { recursive: true });
  return dir;
}

describe("no team directory", () => {
  for (const rel of [
    ".factory/config.json",
    "template/.factory/config.example.json",
    "tests/fixtures/monorepo/.factory/config.json",
  ]) {
    test(`${rel} loads to mergeConfig(raw)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "team-wiring-"));
      cpSync(join(root, rel), join(dir, ".factory", "config.json"));
      const raw = JSON.parse(readFileSync(join(dir, ".factory", "config.json"), "utf8"));
      const merged = mergeConfig(raw);
      const config = await loadConfig(dir);
      expect(config).toEqual(
        merged.repo === "" ? { ...merged, repo: config.repo, base: config.base } : { ...merged, base: config.base },
      );
      const applied = applyTeam({
        repoDir: dir,
        config,
        defaults: mergeConfig({ profile: config.profile }),
        raw,
        check: configProblems,
      });
      expect(applied.config).toBe(config);
    });
  }
});

describe("team repo", () => {
  test("applies workflow, route, label and clamps", async () => {
    const dir = copyTo(join(root, "tests/fixtures/team-repo"));
    const { config, resolved, team } = await loadConfigExplained(dir);
    expect(team).toBe("core");
    expect(config.workflow).toBe("docs-to-pr");
    expect(config.routes.docs?.proof).toBe("check");
    expect(config.labels["factory:ready"]).toBe("ready-for-ai");
    expect(config.merge.policy).toBe("dry-run");
    expect(config.riskPolicy.autoApproveMaxRisk).toBe("low");
    expect(config.protectedPaths).toContain("infra/**");
    expect(config.protectedPaths).toContain("db/**");
    expect(resolved.problems.some((p) => p.includes("roles.review"))).toBe(true);
  });

  test("two teams claiming one repo are refused", async () => {
    const dir = copyTo(join(root, "tests/fixtures/team-repo"));
    writeFileSync(join(dir, ".factory/team/teams/site.yml"), "name: site\nrepos: [ACME/core-api]\n");
    const err = await loadConfig(dir).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("core and site");
  });

  test("a bad team route is refused", async () => {
    const dir = copyTo(join(root, "tests/fixtures/team-repo"));
    writeFileSync(
      join(dir, ".factory/team/teams/core.yml"),
      "name: core\nrepos: [acme/core-api]\nroutes:\n  docs:\n    proof: maybe\n",
    );
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
  });
});
