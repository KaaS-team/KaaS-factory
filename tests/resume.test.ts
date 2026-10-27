// A retry after a failure resumes at the stage that failed, not the last stage that posted a marker.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import { deriveIssueState } from "../src/derive";
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

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const out = {
  triage: {
    "triage-comment.md": "<!-- factory:triage v1 -->\nt",
    "triage.json": JSON.stringify({
      disposition: "proceed",
      type: "bug",
      risk: "low",
      done_when: "x",
      files_expected: ["src/a.ts"],
      gate_level: "make check",
      confidence: 0.9,
    }),
  },
  plan: {
    "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
    "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }),
  },
  build: {
    "status-comment.md": "<!-- factory:status v1 -->\nb",
    "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
  },
  verify: {
    "verdict-comment.md": "<!-- factory:verdict v1 -->\nv",
    "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }),
  },
  pr: { "pr-body.md": "Did it.\nCloses #1" },
};

// Runs triage, plan and a build the gates fail, leaving the issue parked as failed.
async function failedBuild() {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const github = new FakeGitHub([baseIssue(1, [LABEL.ready])]);
  const executor = new MultiStageExecutor();
  const gateRunner = new FakeGateRunner();
  const state = new FactoryState(":memory:");
  state.setToggle("auto_approve_low_risk", true);
  const deps = {
    github,
    git: new FakeGit(),
    state,
    executor,
    gateRunner,
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir,
    workspacesDir,
  };
  const config = mergeConfig({ repo: "acme/widgets" });
  const push = (stage: keyof typeof out) => executor.push(stage, 1, fixtureFor(stage, 1), out[stage]);
  const step = () => advanceIssue(deps, config, github.issues.get(1)!);
  gateRunner.line = "FACTORY_GATES: status=RED passed=1 failed=1 skipped=0 failed_gates=unit";
  for (const s of ["triage", "plan", "build"] as const) push(s);
  expect(await step()).toBe("failed");
  gateRunner.line = "FACTORY_GATES: status=GREEN passed=2 failed=0 skipped=0 failed_gates=-";
  const planRuns = () => state.listStageRuns("acme/widgets", { issue: 1 }).filter((r) => r.stage === "plan").length;
  return { github, state, push, step, planRuns };
}

const failure = (c: { github: FakeGitHub }) =>
  c.github.issues.get(1)!.comments.find((x) => x.body.includes('"stage":"failure"'))!;

test("a build failure resumes at build, not plan", async () => {
  const c = await failedBuild();
  expect(deriveIssueState(c.github.issues.get(1)!).resumeStage).toBe("build");
  c.state.close();
});

test("the failure marker carries the failed stage", async () => {
  const c = await failedBuild();
  expect(failure(c).body).toContain('"stage":"build"');
  c.state.close();
});

test("a failure marker with no stage keeps the old behaviour", async () => {
  const c = await failedBuild();
  const issue = c.github.issues.get(1)!;
  // The status comment carries a build marker of its own, so drop it: this is the thread an older runner left.
  const stripped = {
    ...issue,
    comments: issue.comments
      .filter((x) => !x.body.includes('factory:data {"stage":"build"'))
      .map((x) => (x.body.includes('"stage":"failure"') ? { ...x, body: x.body.replace(/,"stage":"build"/, "") } : x)),
  };
  expect(failure(c).body).not.toBe(stripped.comments.find((x) => x.body.includes('"stage":"failure"'))!.body);
  expect(deriveIssueState(stripped).resumeStage).toBe("plan");
  c.state.close();
});

test("retry after a build failure does not call plan", async () => {
  const c = await failedBuild();
  const before = c.planRuns();
  c.push("build");
  c.push("verify");
  c.push("pr");
  c.github.say(1, "/factory retry");
  expect(await c.step()).toBe("shipped");
  expect(c.planRuns()).toBe(before);
  c.state.close();
});

test("/factory retry plan overrides the derived stage", async () => {
  const c = await failedBuild();
  const before = c.planRuns();
  for (const s of ["plan", "build", "verify", "pr"] as const) c.push(s);
  c.github.say(1, "/factory retry plan");
  expect(await c.step()).toBe("shipped");
  expect(c.planRuns()).toBe(before + 1);
  c.state.close();
});

test("an unknown step name is ignored", async () => {
  const c = await failedBuild();
  const before = c.planRuns();
  for (const s of ["build", "verify", "pr"] as const) c.push(s);
  c.github.say(1, "/factory retry nonsense");
  expect(await c.step()).toBe("shipped");
  expect(c.planRuns()).toBe(before);
  c.state.close();
});
