import { expect, test } from "bun:test";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadConfigExplained } from "../src/config";
import { configHash } from "../src/team/hash";
import { explainLines } from "../src/team/explain";

const root = join(import.meta.dir, "..");
const copy = (rel: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "team-explain-"));
  cpSync(join(root, rel), dir, { recursive: true });
  return dir;
};

test("explain names the level for team, repo and org keys", async () => {
  const dir = copy("tests/fixtures/team-repo");
  const applied = await loadConfigExplained(dir);
  const lines = explainLines({ issue: 7, repo: "acme/core-api", type: "docs", applied });
  expect(lines[0]).toBe("#7 on acme/core-api: team core, type docs");
  expect(lines).toContain('workflow = "docs-to-pr" (team)');
  expect(lines).toContain('labels.factory:ready = "ready-for-ai" (repo)');
  expect(lines).toContain("policy.auto_merge.allowed = false (org)");
  expect(lines).toContain(`config_hash ${configHash(applied.config)}`);
  expect(applied.config).toEqual(await loadConfig(dir));
  expect(lines.some((l) => l.startsWith("routes.docs.proof") && l.endsWith("[this issue]"))).toBe(true);
  expect(lines.some((l) => l.startsWith("problem:") && l.includes("roles.review"))).toBe(true);
});

test("a repo with no team shows only builtin and repo", async () => {
  const dir = copy("tests/fixtures/monorepo");
  const applied = await loadConfigExplained(dir);
  const lines = explainLines({ issue: 1, repo: applied.config.repo, applied });
  expect(lines[0]).toContain("team none");
  const keyLines = lines.slice(2);
  expect(keyLines.length).toBeGreaterThan(0);
  for (const l of keyLines) expect(l.endsWith("(builtin)") || l.endsWith("(repo)")).toBe(true);
});
