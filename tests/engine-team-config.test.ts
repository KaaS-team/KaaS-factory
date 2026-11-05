// The runner's per-issue path applies the team an issue routes to, by label or by a path its body names.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, mergeConfig } from "../src/config";
import { configForIssue, pathsNamedIn } from "../src/engine/team-config";
import type { GhIssue } from "../src/github";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { advanceIssue } from "../src/watch";
import {
  baseIssue,
  FakeGateRunner,
  FakeGit,
  FakeGitHub,
  FakeHoldoutRunner,
  fixtureFor,
  MultiStageExecutor,
} from "./harness";

mkdirSync(tmpdir(), { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "engine-team-"));
const teams = join(dir, ".factory", "team", "teams");
mkdirSync(teams, { recursive: true });
writeFileSync(join(dir, ".factory", "config.json"), JSON.stringify({ repo: "acme/mono" }));
writeFileSync(join(dir, ".factory", "team", "org.yml"), "name: acme\n");
writeFileSync(join(teams, "web.yml"), "name: web\nrepos: [acme/mono]\nautonomy: semi\nowns:\n  labels: [area:web]\n");
writeFileSync(
  join(teams, "api.yml"),
  "name: api\nrepos: [acme/mono]\nautonomy: full\nowns:\n  paths: [services/api/**]\n",
);

const issue = (labels: string[], body = ""): GhIssue => ({
  number: 1,
  title: "t",
  body,
  labels: labels.map((name) => ({ name })),
  comments: [],
});

test("a label routes the run to the team that owns it", async () => {
  const base = await loadConfig(dir);
  const config = await configForIssue(dir, base, issue(["area:web"]));
  expect(config.merge.autonomy).toBe("semi");
});

test("a path the issue body names routes the run to the team that owns it", async () => {
  const base = await loadConfig(dir);
  const config = await configForIssue(dir, base, issue([], "Fix `services/api/users.ts` please"));
  expect(config.merge.autonomy).toBe("full");
});

test("a repo with no team directory keeps its config", async () => {
  const plain = mkdtempSync(join(tmpdir(), "engine-plain-"));
  const base = await loadConfig(dir);
  expect(await configForIssue(plain, base, issue(["area:web"]))).toBe(base);
});

test("only backticked tokens with a slash count as paths", () => {
  expect(pathsNamedIn("`a/b.ts` `x` and ./c/d.ts and `./e/f`")).toEqual(["a/b.ts", "e/f"]);
});

test("advanceIssue runs an issue under the team its label routes to", async () => {
  const clone = mkdtempSync(join(tmpdir(), "engine-team-run-"));
  const ws = mkdtempSync(join(tmpdir(), "engine-team-ws-"));
  const tdir = join(clone, ".factory", "team", "teams");
  mkdirSync(tdir, { recursive: true });
  writeFileSync(join(clone, ".factory", "team", "org.yml"), "name: acme\n");
  writeFileSync(
    join(tdir, "web.yml"),
    "name: web\nrepos: [acme/widgets]\npolicy:\n  autonomy_level: suggest\nowns:\n  labels: [area:web]\n",
  );
  writeFileSync(join(tdir, "api.yml"), "name: api\nrepos: [acme/widgets]\nowns:\n  paths: [services/api/**]\n");
  const github = new FakeGitHub([baseIssue(1, [LABEL.ready, "area:web"])]);
  const state = new FactoryState(":memory:");
  state.setToggle("auto_approve_low_risk", true);
  const executor = new MultiStageExecutor();
  const deps = {
    github,
    git: new FakeGit(),
    state,
    executor,
    gateRunner: new FakeGateRunner(),
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir: clone,
    workspacesDir: ws,
  };
  const triage = {
    disposition: "proceed",
    type: "bug",
    risk: "low",
    done_when: "x",
    files_expected: ["src/a.ts"],
    gate_level: "make check",
    confidence: 0.9,
  };
  executor.push("triage", 1, fixtureFor("triage", 1), {
    "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
    "triage.json": JSON.stringify(triage),
  });
  executor.push("plan", 1, fixtureFor("plan", 1), {
    "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
    "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }),
  });
  writeFileSync(join(clone, ".factory", "config.json"), JSON.stringify({ repo: "acme/widgets" }));
  const config = mergeConfig({ repo: "acme/widgets" });
  // The suggest level pulls the tier back to supervised, so the plan waits for a person instead of
  // auto-approving into a build; without the team applied this run would go on to build.
  expect(await advanceIssue(deps, config, github.issues.get(1)!)).toBe("awaiting-approval");
});
