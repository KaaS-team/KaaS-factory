// Every way a run ends leaves a retro row, and the coverage figure stays at 100 percent.
// retro.test.ts proves the triggers that run a retro inline; these cover failed runs, runs
// closed outside the factory, and runs a workflow finishes with no PR.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retroCoverage } from "../src/engine/retro-finish";
import { mergeConfig } from "../src/config";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { advanceIssue, pollOnce, reconcileClosed } from "../src/watch";
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

function setup(initial: string[]) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-rc-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-rc-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const github = new FakeGitHub([baseIssue(1, initial)]);
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
  return { github, state, executor, config, deps };
}

const retro = {
  "retro-comment.md": "<!-- factory:retro v1 -->\nnothing new",
  "retro.json": JSON.stringify({ outcome: "complete", summary: "nothing new" }),
};

describe("every finished run gets a retro", () => {
  test("a run the triage agent reports failed is covered, and the queued retro runs", async () => {
    const c = setup([LABEL.ready]);
    c.executor.push("triage", 1, fixtureFor("triage", 1), {
      "triage-comment.md": "<!-- factory:triage v1 -->\nx",
      "triage.json": JSON.stringify({ outcome: "failed", summary: "could not read the issue" }),
    });
    c.executor.push("retro", 1, fixtureFor("retro", 1), retro);
    expect(await advanceIssue(c.deps, c.config, c.github.issues.get(1)!)).toBe("failed");
    expect(c.state.getRun(c.config.repo, 1)!.status).toBe("failed");
    expect(retroCoverage(c.state, c.config.repo)).toEqual({ finished: 1, covered: 1, percent: 100, missing: [] });
    expect(c.state.listRetros(c.config.repo)).toEqual([expect.objectContaining({ issue: 1, status: "queued" })]);
    await pollOnce(c.deps, c.config);
    expect(c.state.listRetros(c.config.repo)).toEqual([expect.objectContaining({ issue: 1, status: "done" })]);
    c.state.close();
  });

  test("a parked run whose issue was closed outside the factory is cancelled with a retro", async () => {
    const c = setup([LABEL.needsHuman]);
    c.state.upsertRun({ issue: 1, repo: c.config.repo, title: "t", stage: "plan", status: "needs-human" });
    (c.github.issues.get(1) as { state: string }).state = "CLOSED";
    await reconcileClosed(c.deps, c.config, new Set());
    expect(c.state.getRun(c.config.repo, 1)!.status).toBe("cancelled");
    expect(retroCoverage(c.state, c.config.repo).percent).toBe(100);
    expect(c.state.listRetros(c.config.repo)).toEqual([expect.objectContaining({ issue: 1, outcome: "rejected" })]);
    c.state.close();
  });

  test("a plan-rubric lesson does not stand in for a run's retro", () => {
    const state = new FactoryState(":memory:");
    state.upsertRun({ issue: 7, repo: "acme/widgets", title: "t", stage: "plan", status: "failed" });
    state.completeRetro(state.queueRetro("acme/widgets", 7, "plan-rubric"), { lesson: "l" });
    expect(retroCoverage(state, "acme/widgets")).toEqual({ finished: 1, covered: 0, percent: 0, missing: [7] });
    state.close();
  });

  test("a shipped run waiting on its PR is not yet finished", () => {
    const state = new FactoryState(":memory:");
    state.upsertRun({ issue: 8, repo: "acme/widgets", title: "t", stage: "pr", status: "shipped" });
    state.updateRun("acme/widgets", 8, { pr_url: "https://example.test/pull/1" });
    expect(retroCoverage(state, "acme/widgets").finished).toBe(0);
    state.close();
  });
});
