// The version lives in package.json and in the CI template's pinned runner
// ref; this pins them together so a release cannot bump one and forget the other.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LABEL } from "../src/labels";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("template-ci FACTORY_RUNNER_REF is v<package.json version>", () => {
  const { version } = JSON.parse(read("package.json")) as { version: string };
  const ref = /FACTORY_RUNNER_REF: (\S+)/.exec(read("template-ci/factory.yml.example"))?.[1];
  expect(ref).toBe(`v${version}`);
});

// The repo moved to KaaS-team in v5.0.0; a stale owner would send every adopter's CI to a redirect.
test("the CI template and the README clone line name the same KaaS-team runner repo", () => {
  const repo = /FACTORY_RUNNER_REPO: (\S+)/.exec(read("template-ci/factory.yml.example"))?.[1];
  expect(repo).toBe("KaaS-team/KaaS-factory");
  expect(read("README.md")).toContain(`git clone git@github.com:${repo}.git`);
});

test("the README describes only what exists: every label is listed and no monitor stage is claimed", () => {
  const readme = read("README.md");
  for (const label of Object.values(LABEL)) expect(readme).toContain(`\`${label}\``);
  expect(readme).not.toMatch(/verify, PR, monitor/);
  expect(readme).not.toMatch(/the monitor closes/);
});

test("the README names every agent preset and the config keys that choose one", async () => {
  const { PRESETS } = await import("../src/agents/presets");
  const readme = read("README.md");
  for (const name of Object.keys(PRESETS)) expect(readme).toContain(`"preset": "${name}"`);
  for (const word of ['"agents"', '"stages"', "{{promptFile}}", "FACTORY_ARTIFACT_DIR"]) expect(readme).toContain(word);
});

describe("the CI template", () => {
  const ci = read("template-ci/factory.yml.example");
  const steps = ci.split(/\n(?=\s+- )/);

  test("pins every action to a commit SHA, with its tag beside it", () => {
    const uses = [...ci.matchAll(/uses: (\S+)(.*)/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest).toMatch(/^ # v\d/);
    }
  });

  test("the scan job installs osv-scanner at a pinned version and checks its sha256 before running it", () => {
    const scanJob = ci.slice(ci.indexOf("\n  scan:"), ci.indexOf("\n  manual:"));
    expect(ci).toMatch(/OSV_SCANNER_VERSION: "\d+\.\d+\.\d+"/);
    expect(ci).toMatch(/OSV_SCANNER_SHA256: [0-9a-f]{64}\n/);
    expect(scanJob).toContain("sha256sum -c -");
    expect(scanJob.indexOf("sha256sum -c -")).toBeLessThan(scanJob.indexOf("factory scan --repo-dir"));
  });

  test("checks the target repo out with full history", () => {
    const targets = steps.filter((s) => /uses: actions\/checkout@/.test(s) && !/repository:/.test(s));
    expect(targets.length).toBe(4);
    for (const s of targets) expect(s).toContain("fetch-depth: 0");
  });

  test("never interpolates event data into a script: it reaches the shell through env", () => {
    for (const s of steps) {
      const script = /run: [|>]?([\s\S]*)/.exec(s)?.[1] ?? "";
      expect(script).not.toMatch(/\$\{\{\s*github\.(event|head_ref)/);
    }
  });

  test("a comment or review on a PR runs the issue that PR works on", () => {
    expect(ci).toMatch(/pull_request_review:\n\s+types: \[submitted\]/);
    expect(ci).toContain("github.event.review.author_association");
    expect(ci).toContain('then target="--pr $PR"');
  });
});

// Renamed to KaaS Factory in v5.1.0. History, recorded transcripts, the vendored kit and the
// mutation that reintroduces it keep the old name.
const OLD_NAME_KEPT = [
  "CHANGELOG.md",
  "goals.json",
  "tests/fixtures/",
  "scripts/kaas/",
  "node_modules/",
  ".git",
  ".git/",
  "tests/mutations.json",
];
const ROOT = join(import.meta.dir, "..");
const repoFiles = (dir = ROOT): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const rel = relative(ROOT, path) + (statSync(path).isDirectory() ? "/" : "");
    if (OLD_NAME_KEPT.some((k) => rel === k) || /^(verify|relay)\/target\/|^reports\//.test(rel)) return [];
    return rel.endsWith("/") ? repoFiles(path) : [rel];
  });
test("nothing outside history names the old repo", () => {
  const offenders = repoFiles().filter((rel) => /software[- ]factory/i.test(readFileSync(join(ROOT, rel), "latin1")));
  expect(offenders).toEqual([]);
});

// Lessons and research moved to agentic-ai-lightning-sessions/factory in v5.1.0; a path back
// into them would be a dead link in the product.
test("the product repo carries no teaching material", () => {
  expect(existsSync(join(ROOT, "teach")) || existsSync(join(ROOT, "research"))).toBe(false);
  const offenders = repoFiles().filter((rel) =>
    /(^|[^-\w])(teach|research)\//.test(readFileSync(join(ROOT, rel), "latin1")),
  );
  expect(offenders).toEqual([]);
});
