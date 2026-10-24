// v2.10.0 item 3: a retro row is queued and run after every one of the three
// final outcomes reachable inside watch.ts (merged, /factory cancel = rejected,
// a third verify reject = gave-up), plus the fourth path: the dashboard's
// operator-merge route, which has no Executor and only queues, drained here
// by pollOnce's runQueuedRetros. state.test.ts already proves queueRetro/
// completeRetro store the right fields; these tests prove each trigger site
// actually calls runRetro with the right outcome and that it runs to done.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import type { StageName, StageRunResult } from "../src/executor";
import { FactoryState } from "../src/state";
import { LABEL } from "../src/labels";
import { advanceIssue, pollOnce } from "../src/watch";
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

function setup(initial: string[], overrides: Parameters<typeof mergeConfig>[0] = { repo: "acme/widgets" }, n = 1) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-retro-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-retro-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const github = new FakeGitHub([baseIssue(n, initial)]);
  const git = new FakeGit();
  const state = new FactoryState(":memory:");
  const executor = new MultiStageExecutor();
  const gateRunner = new FakeGateRunner();
  const holdoutRunner = new FakeHoldoutRunner();
  const config = mergeConfig({ repo: "acme/widgets", ...overrides });
  const deps = { github, git, state, executor, gateRunner, holdoutRunner, cloneDir, workspacesDir };
  const push = (stage: StageName, files: Record<string, string>, result?: Partial<StageRunResult>) =>
    executor.push(stage, n, fixtureFor(stage, n), files, result);
  return { n, github, state, executor, config, deps, push };
}

const triage = (o: object = {}) => ({
  "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
  "triage.json": JSON.stringify({
    disposition: "proceed",
    type: "bug",
    risk: "low",
    done_when: "x",
    files_expected: ["src/a.ts"],
    gate_level: "make check",
    confidence: 0.9,
    ...o,
  }),
});
const plan = (risk: "low" | "medium" = "low") => ({
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
  "plan.json": JSON.stringify({ risk, revision: 1, files: ["src/a.ts"], autoApproveEligible: risk === "low" }),
});
const build = () => ({
  "status-comment.md": "<!-- factory:status v1 -->\nbuilding",
  "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
});
const verdict = (result: "pass" | "reject") => ({
  "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
  "verdict.json": JSON.stringify({ result, rounds: 1, findings: [] }),
});
const pr = () => ({ "pr-body.md": "Did it.\nCloses #1" });
const retro = () => ({
  "retro-comment.md": "<!-- factory:retro v1 -->\nnothing new",
  "retro.json": JSON.stringify({ outcome: "complete", summary: "nothing new" }),
});

describe("a retro row is queued and run after each of the four final-outcome triggers", () => {
  test("checkMergePolicy queues and runs a retro with outcome merged, once the PR actually merges", async () => {
    const c = setup([LABEL.ready], {
      repo: "acme/widgets",
      merge: { policy: "auto", autoPaths: [], maxFiles: 10, maxLines: 200 },
    });
    c.state.setToggle("auto_approve_low_risk", true);
    c.push("triage", triage());
    c.push("plan", plan());
    c.push("build", build());
    c.push("verify", verdict("pass"));
    c.push("pr", pr());
    expect(await advanceIssue(c.deps, c.config, c.github.issues.get(c.n)!)).toBe("shipped");
    const prRow = c.github.prs[0]!;
    c.github.queuePrStatus(prRow.number, {
      state: "open",
      headRefOid: "sha1",
      closingIssuesReferences: [{ number: c.n }],
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    });
    c.github.queueMergeReadiness(prRow.number, {
      state: "open",
      isDraft: false,
      baseRefName: c.config.base,
      headRefOid: "sha1",
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      hasUnresolvedReviewThreads: false,
      changesRequestedStale: false,
    });
    c.push("retro", retro());
    await advanceIssue(c.deps, c.config, c.github.issues.get(c.n)!);
    expect(c.github.merged).toEqual([{ repo: c.config.repo, prNumber: prRow.number, headSha: "sha1" }]);
    // "retro" is stored via an explicit `as Stage` cast (Stage itself excludes it by design).
    expect(c.state.listStageRuns(c.config.repo).some((r) => (r.stage as string) === "retro")).toBe(true);
    expect(c.state.listRetros(c.config.repo)).toEqual([
      expect.objectContaining({ issue: c.n, outcome: "merged", status: "done" }),
    ]);
    c.state.close();
  });

  test("/factory cancel queues and runs a retro with outcome rejected", async () => {
    const c = setup([LABEL.awaitingApproval]);
    const waiting = c.github.issues.get(c.n)!;
    waiting.comments = [
      {
        id: 5,
        author: "bot",
        authorAssociation: "OWNER",
        body: "<!-- factory:plan v1 rev=1 -->",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    c.github.say(c.n, "/factory cancel");
    c.push("retro", retro());
    await pollOnce(c.deps, c.config);
    expect(c.github.issues.get(c.n)!.labels.map((l) => l.name)).toEqual([]); // cancelRun strips every factory:* label and closes the issue
    expect(c.state.listStageRuns(c.config.repo).some((r) => (r.stage as string) === "retro")).toBe(true);
    expect(c.state.listRetros(c.config.repo)).toEqual([
      expect.objectContaining({ issue: c.n, outcome: "rejected", status: "done" }),
    ]);
    c.state.close();
  });

  test("a third verify reject queues and runs a retro with outcome gave-up", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.push("triage", triage());
    c.push("plan", plan());
    for (let i = 0; i < 3; i++) {
      c.push("build", build());
      c.push("verify", verdict("reject"));
    }
    c.push("retro", retro());
    expect(await advanceIssue(c.deps, c.config, c.github.issues.get(c.n)!)).toBe("needs-human");
    expect(c.state.listStageRuns(c.config.repo).some((r) => (r.stage as string) === "retro")).toBe(true);
    expect(c.state.listRetros(c.config.repo)).toEqual([
      expect.objectContaining({ issue: c.n, outcome: "gave-up", status: "done" }),
    ]);
    c.state.close();
  });

  test("pollOnce's runQueuedRetros drains a retro the dashboard's operator-merge route only queued", async () => {
    const c = setup([LABEL.inReview]);
    const id = c.state.queueRetro(c.config.repo, c.n, "merged");
    c.push("retro", retro());
    await pollOnce(c.deps, c.config);
    expect(c.state.listQueuedRetros(c.config.repo)).toEqual([]);
    expect(c.state.listRetros(c.config.repo)).toEqual([
      expect.objectContaining({ id, issue: c.n, outcome: "merged", status: "done" }),
    ]);
    c.state.close();
  });
});
