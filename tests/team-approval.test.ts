import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiResult } from "../src/ci";
import { loadConfig, mergeConfig } from "../src/config";
import type { MergeReadiness } from "../src/github";
import {
  type DecideMergeInput,
  decideMerge,
  decideOperatorMerge,
  renderAuditComment,
  renderOperatorAuditComment,
} from "../src/merge-policy";
import { actorFor, type ApprovalPolicy, chainRefusals, mayBuild, mayMerge, parseActor } from "../src/team/approval";
import { resolveTeam } from "../src/team/resolve";
import { teamProblems } from "../src/team/schema";

const readiness = (approvedBy: string[] = []): MergeReadiness => ({
  state: "open",
  isDraft: false,
  baseRefName: "main",
  headRefOid: "sha1",
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  hasUnresolvedReviewThreads: false,
  changesRequestedStale: false,
  approvedBy,
});
const ci: CiResult = {
  prNumber: 1,
  headSha: "sha1",
  status: "passed",
  checks: [{ name: "b", status: "COMPLETED", conclusion: "SUCCESS" }],
};
const docs = [{ path: "docs/a.md", additions: 1, deletions: 0 }];
const sql = [{ path: "db/1.sql", additions: 1, deletions: 0 }];

const input = (approval: ApprovalPolicy | undefined, files = docs, approvedBy: string[] = []): DecideMergeInput => ({
  readiness: readiness(approvedBy),
  ci,
  risk: "low",
  changedFiles: files,
  merge: { ...mergeConfig({}).merge, policy: "auto", autoPaths: ["docs/**", "db/**"] },
  protectedPaths: [],
  expectedBaseRefName: "main",
  approval,
});
const policy = (level: ApprovalPolicy["level"], chains: ApprovalPolicy["chains"] = []): ApprovalPolicy => ({
  level,
  chains,
});
const chain = [{ paths: ["db/**"], approvers: ["alice", "bob"] }];

describe("autonomy levels", () => {
  test("suggest builds nothing and merges nothing", () => {
    expect(mayBuild("suggest")).toBe(false);
    expect(mayMerge("suggest")).toBe(false);
    expect(decideMerge(input(policy("suggest"))).outcome).toBe("refuse");
  });

  test("change-with-approval builds but a person merges", () => {
    expect(mayBuild("change-with-approval")).toBe(true);
    const d = decideMerge(input(policy("change-with-approval")));
    expect(d.outcome).toBe("refuse");
    expect(d.outcome === "refuse" && d.refusals.map((r) => r.reason)).toEqual(["autonomy-level"]);
  });

  test("merge-on-green merges a green PR", () => {
    expect(mayMerge("merge-on-green")).toBe(true);
    expect(decideMerge(input(policy("merge-on-green"))).outcome).toBe("merge");
  });

  test("a level only ever narrows: the lowest of org and team wins", () => {
    const { values } = resolveTeam({
      builtin: {},
      org: { name: "o", policy: { autonomy_level: "change-with-approval" } },
      team: { name: "t", policy: { autonomy_level: "merge-on-green" } },
    });
    expect((values.policy as { autonomy_level: string }).autonomy_level).toBe("change-with-approval");
  });

  test("the schema names a level that does not exist", () => {
    expect(teamProblems({ name: "t", policy: { autonomy_level: "yolo" } }, "team").join(" ")).toContain(
      "policy.autonomy_level must be suggest, change-with-approval, merge-on-green",
    );
  });

  test("a team below merge-on-green pulls the repo's tier back to supervised", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "team-approval-"));
    cpSync(join(import.meta.dir, "fixtures/team-repo"), dir, { recursive: true });
    const file = join(dir, ".factory/team/teams/core.yml");
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}  autonomy_level: change-with-approval\n  approval_chains:\n    - paths: ["db/**"]\n      approvers: [alice, bob]\n`,
    );
    const config = await loadConfig(dir);
    expect(config.merge.autonomy).toBe("supervised");
    expect(config.approval).toEqual({ level: "change-with-approval", chains: chain });
  });
});

describe("approval chains", () => {
  test("a path with a chain merges once every approver has approved in order", () => {
    const d = decideMerge(input(policy("merge-on-green", chain), sql, ["alice", "bob"]));
    expect(d.outcome).toBe("merge");
  });

  test("a missing approver is named and the merge is refused", () => {
    const d = decideMerge(input(policy("merge-on-green", chain), sql, ["alice"]));
    expect(d.outcome).toBe("refuse");
    expect(d.outcome === "refuse" && d.refusals.map((r) => r.reason)).toEqual(["approval-chain"]);
    expect(d.outcome === "refuse" && d.refusals[0]?.detail).toContain("missing the approval of bob");
  });

  test("an approver out of order is refused", () => {
    const out = chainRefusals(chain, sql, ["bob", "alice"]);
    expect(out).toHaveLength(1);
    expect(out[0]?.detail).toContain("bob approved before the one ahead of them");
  });

  test("a path outside the chain needs none", () => {
    expect(chainRefusals(chain, docs, [])).toEqual([]);
  });

  test("the dashboard's click waits for the chain too", () => {
    const d = decideOperatorMerge(readiness(["alice"]), ci, undefined, { chains: chain, files: sql });
    expect(d.outcome).toBe("refuse");
    expect(decideOperatorMerge(readiness(["alice", "bob"]), ci, undefined, { chains: chain, files: sql }).outcome).toBe(
      "merge",
    );
    expect(
      decideOperatorMerge(readiness(["alice", "bob"]), ci, undefined, { chains: chain, files: undefined }).outcome,
    ).toBe("refuse");
  });

  test("the schema rejects a chain with no approvers", () => {
    const bad = teamProblems({ name: "t", policy: { approval_chains: [{ paths: ["db/**"], approvers: [] }] } }, "team");
    expect(bad.join(" ")).toContain("policy.approval_chains[0] needs paths and approvers");
  });

  test("a team adds chains to the org's; none is dropped", () => {
    const { values } = resolveTeam({
      builtin: {},
      org: { name: "o", policy: { approval_chains: chain } },
      team: { name: "t", policy: { approval_chains: [{ paths: ["infra/**"], approvers: ["carol"] }] } },
    });
    expect((values.policy as { approval_chains: unknown[] }).approval_chains).toHaveLength(2);
  });
});

describe("composite identity", () => {
  test("the audit comment records the agent and the person it acted for", () => {
    const decision = decideMerge(input(policy("merge-on-green"), docs, ["dana"]));
    const body = renderAuditComment(decision, actorFor(["erin", "dana"]));
    expect(parseActor(body)).toEqual({ agent: "factory", person: "dana" });
    expect(body).toContain("Acted as agent factory for dana.");
  });

  test("a merge with no approver is recorded as unattributed, not left blank", () => {
    expect(actorFor([])).toEqual({ agent: "factory", person: "unattributed" });
  });

  test("the operator comment carries the person who clicked", () => {
    const d = decideOperatorMerge(readiness(), ci);
    expect(parseActor(renderOperatorAuditComment(d, { agent: "dashboard", person: "frank" }))).toEqual({
      agent: "dashboard",
      person: "frank",
    });
    expect(parseActor(renderOperatorAuditComment(d))).toBe(undefined);
  });
});

describe("suggest stops the run before the build", () => {
  test("a run plans, then parks without ever running the build stage", async () => {
    const { afterAll } = await import("bun:test");
    const { rmSync } = await import("node:fs");
    const { LABEL } = await import("../src/labels");
    const { FactoryState } = await import("../src/state");
    const { advanceIssue } = await import("../src/watch");
    const h = await import("./harness");
    mkdirSync(tmpdir(), { recursive: true });
    const workspacesDir = mkdtempSync(join(tmpdir(), "team-suggest-ws-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "team-suggest-clone-"));
    afterAll(() => {
      rmSync(workspacesDir, { recursive: true, force: true });
      rmSync(cloneDir, { recursive: true, force: true });
    });
    const github = new h.FakeGitHub([h.baseIssue(1, [LABEL.ready])]);
    const state = new FactoryState(":memory:");
    state.setToggle("auto_approve_low_risk", true);
    const executor = new h.MultiStageExecutor();
    const deps = {
      github,
      git: new h.FakeGit(),
      state,
      executor,
      gateRunner: new h.FakeGateRunner(),
      holdoutRunner: new h.FakeHoldoutRunner(),
      cloneDir,
      workspacesDir,
    };
    const config = { ...mergeConfig({ repo: "acme/widgets" }), approval: policy("suggest") };
    const triage = {
      disposition: "proceed",
      type: "bug",
      risk: "low",
      done_when: "x",
      files_expected: ["src/a.ts"],
      gate_level: "make check",
      confidence: 0.9,
    };
    executor.push("triage", 1, h.fixtureFor("triage", 1), {
      "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
      "triage.json": JSON.stringify(triage),
    });
    executor.push("plan", 1, h.fixtureFor("plan", 1), {
      "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
      "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }),
    });
    expect(await advanceIssue(deps, config, github.issues.get(1)!)).toBe("needs-human");
    const bodies = github.issues.get(1)!.comments.map((c) => c.body);
    expect(bodies.some((b) => b.includes("autonomy level is suggest"))).toBe(true);
  });
});

describe("the watcher's merge path", () => {
  test("tierInput hands the team's approval policy to decideMerge", async () => {
    const { tierInput } = await import("../src/merge-autonomy");
    const config = { ...mergeConfig({ repo: "a/b" }), approval: policy("suggest", chain) };
    expect(tierInput(undefined, config, "low").approval).toEqual(policy("suggest", chain));
  });

  test("settleMerge posts the audit comment with the person who approved", async () => {
    const { settleMerge } = await import("../src/merge-autonomy");
    const posted: string[] = [];
    const merged: number[] = [];
    const config = mergeConfig({ repo: "a/b" });
    const decision = decideMerge(input(policy("merge-on-green"), docs, ["dana"]));
    const deps = { github: { mergePr: async (_r: string, n: number) => void merged.push(n) } };
    const run = {
      worktree: "/w",
      pr: 7,
      branch: "b",
      issue: 1,
      by: ["dana"],
      post: async (b: string) => void posted.push(b),
    };
    await settleMerge(deps as never, config, undefined, decision, run);
    expect(parseActor(posted[0] ?? "")).toEqual({ agent: "factory", person: "dana" });
    expect(merged).toEqual([7]);
  });
});
