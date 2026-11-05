// The retro proposes the prune: each scaffold test a plan tagged becomes one lesson row.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import { pruneLesson } from "../src/engine/retro-finish";
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
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function run(scaffoldTests: string[]) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-prune-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-prune-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const github = new FakeGitHub([baseIssue(1, [LABEL.ready])]);
  const state = new FactoryState(":memory:");
  const executor = new MultiStageExecutor();
  const config = mergeConfig({ repo: "acme/widgets" });
  const deps = {
    github,
    git: new FakeGit(),
    state,
    executor,
    gateRunner: new FakeGateRunner(),
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir,
    workspacesDir,
  };
  state.setToggle("auto_approve_low_risk", true);
  const push = (stage: Parameters<typeof executor.push>[0], files: Record<string, string>) =>
    executor.push(stage, 1, fixtureFor(stage, 1), files);
  push("triage", {
    "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
    "triage.json": JSON.stringify({
      disposition: "proceed",
      type: "bug",
      risk: "low",
      done_when: "x",
      files_expected: ["src/a.ts"],
      gate_level: "make check",
      confidence: 0.9,
    }),
  });
  push("plan", {
    "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
    "plan.json": JSON.stringify({
      risk: "low",
      revision: 1,
      files: ["src/a.ts"],
      autoApproveEligible: true,
      proof: "test",
      permanentTests: ["tests/a.test.ts > keeps"],
      scaffoldTests,
    }),
  });
  for (let i = 0; i < 3; i++) {
    push("build", {
      "status-comment.md": "<!-- factory:status v1 -->\nbuilding",
      "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
    });
    push("verify", {
      "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
      "verdict.json": JSON.stringify({ result: "reject", rounds: 1, findings: [] }),
    });
  }
  push("retro", {
    "retro-comment.md": "<!-- factory:retro v1 -->\nnothing new",
    "retro.json": JSON.stringify({ outcome: "complete", summary: "nothing new" }),
  });
  return { deps, config, state, github };
}

test("a finished run whose plan tagged scaffold tests gets a prune lesson naming each one", async () => {
  const c = run(["tests/a.test.ts > drives the build", "tests/a.test.ts > checks a stub"]);
  await advanceIssue(c.deps, c.config, c.github.issues.get(1)!);
  const lessons = c.state
    .listRetros(c.config.repo)
    .map((r) => r.lesson)
    .filter((l): l is string => !!l);
  expect(lessons).toHaveLength(1);
  expect(lessons[0]).toContain("tests/a.test.ts > drives the build");
  expect(lessons[0]).toContain("tests/a.test.ts > checks a stub");
  expect(lessons[0]).toContain("Prune or graduate");
  c.state.close();
});

test("a plan with no scaffold tests proposes no prune", async () => {
  const c = run([]);
  await advanceIssue(c.deps, c.config, c.github.issues.get(1)!);
  expect(c.state.listRetros(c.config.repo).filter((r) => r.lesson)).toEqual([]);
  c.state.close();
});

test("pruneLesson ignores a plan without a scaffold list", () => {
  expect(pruneLesson(1, undefined) === undefined).toBe(true);
  expect(pruneLesson(1, { scaffoldTests: [3] }) === undefined).toBe(true);
});
