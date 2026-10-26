// Goal auto-merge-low-risk, end to end through the watcher: a PR merges with no human only when every
// check and acceptance proof is green and the diff is inside the low-risk class (src/low-risk.ts).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptanceVerdict } from "../src/acceptance";
import { runDir } from "../src/artifacts";
import { type DEFAULT_CONFIG, mergeConfig } from "../src/config";
import { EventBus } from "../src/engine/bus";
import { LABEL } from "../src/labels";
import type { ChangedFile } from "../src/merge-policy";
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

const AUTO = { policy: "auto", autoPaths: [], maxFiles: 10, maxLines: 200 } as const;
const docs: ChangedFile[] = [{ path: "docs/guide.md", additions: 12, deletions: 3 }];
const green: AcceptanceVerdict = {
  base: "main",
  acs: [
    {
      spec: "s",
      ac: "AC1",
      text: "the guide says how",
      holdout: ["t"],
      new: true,
      base: "fail",
      head: "pass",
      ok: true,
    },
  ],
  errors: [],
};
const red: AcceptanceVerdict = { ...green, acs: [{ ...green.acs[0]!, head: "fail", ok: false }] };

interface Case {
  readonly files: ChangedFile[];
  readonly acceptance?: AcceptanceVerdict;
  readonly ci?: "SUCCESS" | "FAILURE";
  readonly labels?: string[];
  readonly merge?: Partial<typeof DEFAULT_CONFIG.merge>;
}

// Drives one low-risk issue to an in-review PR, then runs the merge poll once.
async function mergePoll(c: Case): Promise<{ merged: number; comments: string[] }> {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const github = new FakeGitHub([baseIssue(1, [LABEL.ready, ...(c.labels ?? [])])]);
  const git = new FakeGit();
  const state = new FactoryState(":memory:");
  const executor = new MultiStageExecutor();
  const config = mergeConfig({ repo: "acme/widgets", merge: { ...AUTO, ...c.merge } });
  const bus = new EventBus({ store: state, sinks: [], source: "s", autoDeliver: false });
  const deps = {
    github,
    git,
    state,
    executor,
    gateRunner: new FakeGateRunner(),
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir,
    workspacesDir,
    bus,
  };
  state.setToggle("auto_approve_low_risk", true);
  const push = (stage: "triage" | "plan" | "build" | "verify" | "pr", files: Record<string, string>) =>
    executor.push(stage, 1, fixtureFor(stage, 1), files);
  const files = docs.map((f) => f.path);
  push("triage", {
    "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
    "triage.json": JSON.stringify({
      disposition: "proceed",
      type: "docs",
      risk: "low",
      done_when: "x",
      files_expected: files,
      gate_level: "make check",
      confidence: 0.9,
    }),
  });
  push("plan", {
    "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
    "plan.json": JSON.stringify({ risk: "low", revision: 1, files, autoApproveEligible: true }),
  });
  push("build", {
    "status-comment.md": "<!-- factory:status v1 -->\nbuilding",
    "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
  });
  push("verify", {
    "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
    "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }),
  });
  push("pr", { "pr-body.md": "Did it.\nCloses #1" });
  const step = () => advanceIssue(deps, config, github.issues.get(1)!);
  await step();
  const pr = github.prs[0]!;
  github.queuePrStatus(pr.number, {
    state: "open",
    headRefOid: "sha1",
    closingIssuesReferences: [{ number: 1 }],
    statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: c.ci ?? "SUCCESS" }],
  });
  github.queueMergeReadiness(pr.number, {
    state: "open",
    isDraft: false,
    baseRefName: config.base,
    headRefOid: "sha1",
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    hasUnresolvedReviewThreads: false,
    changesRequestedStale: false,
  });
  git.diffStatOverride = c.files;
  if (c.acceptance) {
    const run = join(workspacesDir, "issue-1", runDir(1));
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "acceptance.json"), JSON.stringify(c.acceptance));
  }
  // The forged labels ride on the issue the merge poll reads, not only the one it was filed with.
  for (const name of c.labels ?? []) github.issues.get(1)!.labels.push({ name });
  await step();
  return { merged: github.merged.length, comments: github.issues.get(1)!.comments.map((x) => x.body) };
}

test("a docs-only diff with every check and acceptance proof green merges with no human", async () => {
  const r = await mergePoll({ files: docs, acceptance: green });
  expect(r.merged).toBe(1);
  expect(r.comments.some((b) => b.includes("all gates passed"))).toBe(true);
});

test("the same low-risk diff with one red proof is left for a human", async () => {
  const acceptance = await mergePoll({ files: docs, acceptance: red });
  expect(acceptance.merged).toBe(0);
  expect(acceptance.comments.some((b) => b.includes("**acceptance-red**"))).toBe(true);
  const ci = await mergePoll({ files: docs, acceptance: green, ci: "FAILURE" });
  expect(ci.merged).toBe(0);
  expect(ci.comments.some((b) => b.includes("**ci-failed**"))).toBe(true);
});

test("a diff touching a migration, auth, dependency, CI or infra path never merges, whatever the config class says", async () => {
  const wide = { autoPaths: ["**"], lowRiskPaths: ["**"] };
  for (const path of [
    "db/migrations/001_users.sql",
    "src/auth/session.ts",
    "package.json",
    ".github/workflows/ci.yml",
    "infra/main.tf",
    "tests/auth/login.test.ts",
  ]) {
    const r = await mergePoll({
      files: [...docs, { path, additions: 1, deletions: 0 }],
      acceptance: green,
      merge: wide,
    });
    expect(r.merged, path).toBe(0);
    expect(
      r.comments.some((b) => b.includes("**outside-low-risk-class**")),
      path,
    ).toBe(true);
  }
});

test("a forged label cannot widen the low-risk class", async () => {
  const code: ChangedFile[] = [{ path: "lib/billing.ts", additions: 3, deletions: 1 }];
  const forged = ["docs", "risk:low", "low-risk", "factory:low-risk", "factory:auto-merge"];
  const r = await mergePoll({ files: code, acceptance: green, labels: forged });
  expect(r.merged).toBe(0);
  expect(r.comments.some((b) => b.includes("not docs, tests or copy: lib/billing.ts"))).toBe(true);
  // The same labels on a docs-only diff change nothing either: the diff decides, not the label.
  expect((await mergePoll({ files: docs, acceptance: green, labels: forged })).merged).toBe(1);
});
