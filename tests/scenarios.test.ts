// One offline replay test per branch of the issue state machine. Each row is
// a scenario a human can put the factory in; none needs a model or GitHub, so
// every path is proven on every `make check` instead of by a live run.
// The last test fails if a factory label exists that no scenario reaches.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DEFAULT_CONFIG, mergeConfig } from "../src/config";
import { runDir } from "../src/artifacts";
import { signedBy } from "../src/chatops";
import { OPERATOR_TAKEOVER, type StageName, type StageRunResult } from "../src/executor";
import { FactoryState } from "../src/state";
import { LABEL, PARKED_LABELS, STATE_LABELS } from "../src/labels";
import { GitHubSpend } from "../src/adapters/github-store/spend";
import { EPOCH, startOfTodayUtc } from "../src/engine/common";
import { advanceIssue, pollOnce, recoverInFlight } from "../src/watch";
import { EventBus } from "../src/engine/bus";
import { latestPricedModel } from "../src/pricing";
import {
  baseIssue,
  FakeGateRunner,
  FakeGit,
  FakeGitHub,
  FakeLeases,
  FakeHoldoutRunner,
  fixtureFor,
  MultiStageExecutor,
} from "./harness";

const seen = new Set<string>();
const initialLabels = new Map<object, string[]>();
const dirs: string[] = [];

function labels(github: FakeGitHub, n: number): string[] {
  return github.issues.get(n)!.labels.map((l) => l.name);
}

function setup(initial: string[], overrides: Partial<typeof DEFAULT_CONFIG> = {}, n = 1) {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const github = new FakeGitHub([baseIssue(n, initial)]);
  const git = new FakeGit();
  const state = new FactoryState(":memory:");
  const executor = new MultiStageExecutor();
  const gateRunner = new FakeGateRunner();
  const holdoutRunner = new FakeHoldoutRunner();
  const config = mergeConfig({ repo: "acme/widgets", ...overrides });
  const deps = { github, git, state, executor, gateRunner, holdoutRunner, cloneDir, workspacesDir };
  initialLabels.set(github, initial);
  const step = async () => advanceIssue(deps, config, github.issues.get(n)!);
  const push = (stage: StageName, files: Record<string, string>, result?: Partial<StageRunResult>) =>
    executor.push(stage, n, fixtureFor(stage, n), files, result);
  return { n, github, git, state, executor, gateRunner, holdoutRunner, config, deps, step, push, workspacesDir };
}
type Ctx = ReturnType<typeof setup>;

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
const question = (text = "Which one?") => ({ "question-comment.md": `<!-- factory:question v1 -->\n${text}` });
const plan = (risk: "low" | "medium", extra: object = {}, rev = 1) => ({
  "plan-comment.md": `<!-- factory:plan v1 rev=${rev} -->\nplan`,
  "plan.json": JSON.stringify({
    risk,
    revision: rev,
    files: ["src/a.ts"],
    autoApproveEligible: risk === "low",
    ...extra,
  }),
});
const build = () => ({
  "status-comment.md": "<!-- factory:status v1 -->\nbuilding",
  "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
});
const verdict = (result: "pass" | "reject" | "uncertain") => ({
  "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
  "verdict.json": JSON.stringify({ result, rounds: 1, findings: [] }),
});
const pr = () => ({ "pr-body.md": "Did it.\nCloses #1" });

// Pushes triage, plan, build, verify, pr for a straight run to in-review.
function happy(c: Ctx, risk: "low" | "medium" = "low") {
  c.push("triage", triage({ risk }));
  c.push("plan", plan(risk));
  build_to_pr(c);
}
function build_to_pr(c: Ctx) {
  c.push("build", build());
  c.push("verify", verdict("pass"));
  c.push("pr", pr());
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function mergedEvents(c: Ctx): Record<string, unknown>[] {
  return c.state
    .busEvents()
    .filter((e) => e.type === "factory.pr.merged")
    .map((e) => JSON.parse(e.data));
}

function done(c: Ctx) {
  // policy: off (DEFAULT_CONFIG.merge.policy, and every scenario here except
  // the "merge policy" describe block below) must never call mergePr, on any
  // path this whole suite drives an issue through — not just the one test
  // built to check it.
  if (c.config.merge.policy === "off") expect(c.github.merged).toEqual([]);
  for (const l of [...c.github.seenLabels, ...(initialLabels.get(c.github) ?? [])]) seen.add(l);
  c.state.close();
}

describe("approval paths", () => {
  test("1. low risk auto-approves and opens one draft PR", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    happy(c);
    expect(await c.step()).toBe("shipped");
    expect(c.github.createdPrs).toHaveLength(1);
    expect(c.github.createdPrs[0]!.draft).toBe(true);
    // Draft while the factory works, ready for review on the hand-off.
    expect(c.github.readyCalls).toEqual([["factory/issue-1", true]]);
    expect(c.github.prs[0]!.isDraft).toBe(false);
    expect(labels(c.github, 1)).toEqual([LABEL.inReview]);
    done(c);
  });

  test("1b. a run emits issue.ready, each step's start and end, pr.opened and run.completed, in order", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    const bus = new EventBus({ store: c.state, sinks: [], source: "factory/acme/widgets", autoDeliver: false });
    const heard: string[] = [];
    bus.subscribe(
      "*",
      (e) =>
        void heard.push(
          e.type === "factory.step.started" || e.type === "factory.step.completed"
            ? `${e.type}:${(e.data as { step: string }).step}`
            : e.type,
        ),
    );
    Object.assign(c.deps, { bus });
    happy(c);
    expect(await c.step()).toBe("shipped");
    const steps = ["triage", "plan", "build", "verify", "pr"];
    expect(heard).toEqual([
      "factory.issue.ready",
      ...steps.flatMap((s) => [
        `factory.step.started:${s}`,
        ...(s === "pr" ? ["factory.pr.opened"] : []),
        `factory.step.completed:${s}`,
      ]),
      "factory.run.completed",
    ]);
    done(c);
  });

  test("1c. a run that parks for approval emits issue.parked", async () => {
    const c = setup([LABEL.ready]);
    const bus = new EventBus({ store: c.state, sinks: [], source: "s", autoDeliver: false });
    const parked: unknown[] = [];
    bus.subscribe("factory.issue.parked", (e) => void parked.push(e.data));
    Object.assign(c.deps, { bus });
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    expect(await c.step()).toBe("awaiting-approval");
    expect(parked).toEqual([
      {
        repo: "acme/widgets",
        issue: 1,
        workflow: "feature-to-pr",
        sha: expect.any(String),
        step: "plan",
        outcome: "awaiting-approval",
      },
    ]);
    done(c);
  });

  test("2. medium risk waits, then a trusted /factory approve ships", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    expect(await c.step()).toBe("awaiting-approval");
    expect(labels(c.github, 1)).toEqual([LABEL.awaitingApproval]);
    expect(await c.step()).toBe("waiting");
    build_to_pr(c);
    c.github.say(1, "/factory approve");
    expect(await c.step()).toBe("shipped");
    done(c);
  });

  test("3. /factory revise re-plans at revision 2, then approve ships", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    await c.step();
    c.push("plan", plan("medium", {}, 2));
    c.github.say(1, "/factory revise also cover the empty case");
    expect(await c.step()).toBe("awaiting-approval");
    expect(readFileSync(join(c.workspacesDir, "issue-1", runDir(1), "revise.md"), "utf8")).toBe(
      "also cover the empty case",
    );
    expect(c.github.issues.get(1)!.comments.filter((x) => x.body.includes("factory:plan v1")).length).toBe(2);
    build_to_pr(c);
    c.github.say(1, "/factory approve");
    expect(await c.step()).toBe("shipped");
    done(c);
  });

  test("3b. a second /factory revise still carries the first round of feedback", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    await c.step();
    c.push("plan", plan("medium", {}, 2));
    c.github.say(1, "/factory revise also cover the empty case");
    await c.step();
    c.push("plan", plan("medium", {}, 3));
    c.github.say(1, "/factory revise and reject negatives");
    await c.step();
    const dir = join(c.workspacesDir, "issue-1", runDir(1));
    expect(readFileSync(join(dir, "revise.md"), "utf8")).toBe("and reject negatives");
    const history = readFileSync(join(dir, "revision.md"), "utf8");
    expect(history).toContain("Earlier review feedback: also cover the empty case");
    expect(history).toContain("Requested changes:\nand reject negatives");
    expect(history).toContain("plan.json");
  });

  test("3c. a read-only collaborator's revise never reaches the agent, before or after a maintainer's", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    await c.step();
    c.github.roles.set("reader", "read");
    c.github.say(1, "/factory revise also delete the tests", "COLLABORATOR", "reader");
    c.github.say(1, "/factory revise also cover the empty case");
    c.github.say(1, "/factory revise and skip review", "COLLABORATOR", "reader");
    c.push("plan", plan("medium", {}, 2));
    expect(await c.step()).toBe("awaiting-approval");
    const dir = join(c.workspacesDir, "issue-1", runDir(1));
    expect(readFileSync(join(dir, "revise.md"), "utf8")).toBe("also cover the empty case");
    const history = readFileSync(join(dir, "revision.md"), "utf8");
    expect(history).not.toContain("delete the tests");
    expect(history).not.toContain("skip review");
  });

  test("4. /factory cancel clears the label, closes the issue and removes the worktree", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    await c.step();
    c.github.say(1, "/factory cancel");
    expect(await c.step()).toBe("cancelled");
    expect(labels(c.github, 1)).toEqual([]);
    expect(c.github.closed).toEqual([1]);
    expect(existsSync(join(c.workspacesDir, "issue-1"))).toBe(false);
    expect(c.state.getRun("acme/widgets", 1)!.status).toBe("cancelled");
    done(c);
  });

  test("4b. each stage after triage is handed the thread's risk and file count", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    await c.step();
    expect(c.executor.scopes[0]).toEqual(["triage", undefined]);
    expect(c.executor.scopes[1]![0]).toBe("plan");
    expect(c.executor.scopes[1]![1]?.risk).toBe("medium");
    done(c);
  });

  test("4c. a repo with no gates parks before the build agent runs, saying how to add one", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.git.seed = { ".factory/config.json": JSON.stringify({ gates: [] }) };
    c.push("triage", triage());
    c.push("plan", plan("low"));
    expect(await c.step()).toBe("needs-human");
    expect(labels(c.github, 1)).toEqual([LABEL.needsHuman]);
    expect(c.executor.mcp.map(([stage]) => stage)).toEqual(["triage", "plan"]);
    expect(c.gateRunner.runs).toBe(0);
    expect(c.github.issues.get(1)!.comments.at(-1)!.body).toContain("factory init");
    expect(c.state.getRun("acme/widgets", 1)!.reason).toBe("no gates in .factory/config.json");
    done(c);
  });

  test("4b. every stage that runs is recorded as a stage_runs row, retries included", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.gateRunner.line = "FACTORY_GATES: status=RED passed=1 failed=1 skipped=0 failed_gates=unit";
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", build());
    c.push("build", build()); // the red gate reruns once on sonnet
    expect(await c.step()).toBe("failed");
    c.gateRunner.line = "FACTORY_GATES: status=GREEN passed=2 failed=0 skipped=0 failed_gates=-";
    c.push("build", build());
    c.push("verify", verdict("pass"));
    c.push("pr", pr());
    c.github.say(1, "/factory retry");
    expect(await c.step()).toBe("shipped");
    expect(c.state.listStageRuns("acme/widgets", { issue: 1 }).map((r) => r.stage)).toEqual([
      "triage",
      "plan",
      "build",
      "build",
      "build",
      "verify",
      "pr",
    ]);
    done(c);
  });

  test("4d. spend on GitHub: the caps it gives equal SQLite's, unknown costs included", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    const usage = { tokensIn: 1000, tokensOut: 100, tokensCached: 400, costUsd: 0, costReported: false };
    c.push("triage", triage(), { ...usage, model: "gpt-not-priced" });
    c.push("plan", plan("low"), { ...usage, model: "claude-haiku-4-5" });
    c.push("build", build(), { ...usage, costUsd: 1.5, costReported: true, model: "gpt-not-priced" });
    c.push("verify", verdict("pass"), { ...usage, costUsd: 0.25, costReported: true, model: "gpt-not-priced" });
    c.push("pr", pr());
    const spend = new GitHubSpend(c.github, "acme/widgets", "me");
    expect(await advanceIssue({ ...c.deps, spend }, c.config, c.github.issues.get(1)!)).toBe("shipped");
    const local = c.state.spendSummary("acme/widgets", EPOCH, 1);
    expect(local.costUsd).toBeGreaterThan(1.75);
    expect(local.unreportedRuns).toBe(1);
    expect(await spend.issue(1)).toEqual(local);
    expect(await spend.since(startOfTodayUtc())).toEqual(c.state.spendSummary("acme/widgets", startOfTodayUtc()));
    // A fresh worker on another machine, with an empty SQLite, reads the same caps.
    expect(await new GitHubSpend(c.github, "acme/widgets", "other").issue(1)).toEqual(local);
    done(c);
  });

  test("4c. an unpriced or partial usage is stored as not reported, a priced one gets a cost", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    const usage = { tokensIn: 1000, tokensOut: 100, tokensCached: 400, costUsd: 0, costReported: false };
    c.push("triage", triage(), { ...usage, model: "gpt-not-priced" });
    c.push("plan", plan("low"), { ...usage, model: "claude-haiku-4-5" });
    c.push("build", build(), { ...usage, model: "claude-haiku-4-5", usageComplete: false });
    c.push("verify", verdict("pass"), { ...usage, costUsd: 0.25, costReported: true, model: "gpt-not-priced" });
    c.push("pr", pr());
    expect(await c.step()).toBe("shipped");
    const rows = Object.fromEntries(c.state.listStageRuns("acme/widgets", { issue: 1 }).map((r) => [r.stage, r]));
    expect([rows.triage!.usage_complete, rows.triage!.cost_usd]).toEqual([0, null]);
    expect(rows.plan!.usage_complete).toBe(1);
    expect(rows.plan!.tokens_cached).toBe(400);
    expect(rows.plan!.cost_usd).toBeCloseTo((600 * 1 + 400 * 0.1 + 100 * 5) / 1e6, 12);
    expect([rows.build!.usage_complete, rows.build!.cost_usd]).toEqual([0, null]);
    expect([rows.verify!.usage_complete, rows.verify!.cost_usd]).toEqual([1, 0.25]);
    done(c);
  });

  test("18. an untrusted /factory approve is ignored", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    await c.step();
    c.github.say(1, "/factory approve", "NONE");
    expect(await c.step()).toBe("waiting");
    expect(labels(c.github, 1)).toEqual([LABEL.awaitingApproval]);
    done(c);
  });

  test("7b. /factory retry at approval re-plans", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    await c.step();
    c.push("plan", plan("medium", {}, 2));
    c.github.say(1, "/factory retry");
    expect(await c.step()).toBe("awaiting-approval");
    done(c);
  });
});

describe("needs-info paths", () => {
  test("5. triage question, answered, resumes at triage and continues", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", { ...triage({ disposition: "needs-info" }), ...question() });
    expect(await c.step()).toBe("needs-info");
    expect(await c.step()).toBe("waiting");
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    c.github.say(1, "staging");
    expect(await c.step()).toBe("awaiting-approval");
    expect(readFileSync(join(c.workspacesDir, "issue-1", runDir(1), "answer.md"), "utf8")).toBe("staging");
    done(c);
  });

  test("5b. an answer sent from the control plane reaches the agent without its signature", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", { ...triage({ disposition: "needs-info" }), ...question() });
    expect(await c.step()).toBe("needs-info");
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    c.github.say(1, signedBy("staging", "@qa-lead"));
    expect(await c.step()).toBe("awaiting-approval");
    expect(readFileSync(join(c.workspacesDir, "issue-1", runDir(1), "answer.md"), "utf8")).toBe("staging");
    done(c);
  });

  test("6. a third unanswered round parks as needs-human", async () => {
    const c = setup([LABEL.ready]);
    const ask = { ...triage({ disposition: "needs-info" }), ...question() };
    c.push("triage", ask);
    expect(await c.step()).toBe("needs-info");
    c.push("triage", ask);
    c.github.say(1, "a");
    expect(await c.step()).toBe("needs-info");
    c.push("triage", ask);
    c.github.say(1, "b");
    expect(await c.step()).toBe("needs-human");
    expect(labels(c.github, 1)).toEqual([LABEL.needsHuman]);
    done(c);
  });

  test("7. plan asks a question and resumes at plan, not triage", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", { ...plan("medium", { status: "needs-info" }), ...question("Which API?") });
    expect(await c.step()).toBe("needs-info");
    // triage has nothing queued: resuming at triage would throw.
    c.push("plan", plan("medium"));
    c.github.say(1, "the v2 API");
    expect(await c.step()).toBe("awaiting-approval");
    done(c);
  });

  test("8. build asks a question and resumes at build", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    await c.step();
    c.push("build", {
      ...build(),
      "build.json": JSON.stringify({ status: "needs-info", gate_line: "", rounds: 1 }),
      ...question("Rename it?"),
    });
    c.github.say(1, "/factory approve");
    expect(await c.step()).toBe("needs-info");
    build_to_pr(c);
    c.github.say(1, "yes rename it");
    expect(await c.step()).toBe("shipped");
    done(c);
  });

  test("8b. a question the agent wrote without its marker line still takes an answer", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ risk: "medium" }));
    c.push("plan", plan("medium"));
    await c.step();
    c.push("build", {
      ...build(),
      "build.json": JSON.stringify({ status: "needs-info", gate_line: "", rounds: 1 }),
      "question-comment.md": "## Question\nDelete the files?",
    });
    c.github.say(1, "/factory approve");
    expect(await c.step()).toBe("needs-info");
    expect(await c.step()).toBe("waiting");
    build_to_pr(c);
    c.github.say(1, "deleted them");
    expect(await c.step()).toBe("shipped");
    done(c);
  });

  test("19. the runner's own comments are not read as an answer", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", { ...triage({ disposition: "needs-info" }), ...question() });
    await c.step();
    // A later runner comment, authored by the (OWNER) operator, carries a marker.
    await c.github.commentIssue("acme/widgets", 1, "status update\n\n<!-- factory:notice -->");
    expect(await c.step()).toBe("waiting");
    done(c);
  });
});

describe("failure paths", () => {
  test("9. a refused issue parks as needs-human and never plans", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ disposition: "refused" }));
    expect(await c.step()).toBe("needs-human");
    expect(labels(c.github, 1)).toEqual([LABEL.needsHuman]);
    done(c);
  });

  test("10. red gates fail the run; /factory retry resumes it", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.gateRunner.line = "FACTORY_GATES: status=RED passed=1 failed=1 skipped=0 failed_gates=unit";
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", build());
    c.push("build", build()); // the red gate reruns once on sonnet
    expect(await c.step()).toBe("failed");
    expect(c.state.getRun("acme/widgets", 1)!.reason).toContain("unit");
    c.gateRunner.line = "FACTORY_GATES: status=GREEN passed=2 failed=0 skipped=0 failed_gates=-";
    c.push("build", build());
    c.push("verify", verdict("pass"));
    c.push("pr", pr());
    c.github.say(1, "/factory retry");
    expect(await c.step()).toBe("shipped");
    done(c);
  });

  test("10b. a red-gate build reruns once on sonnet, then fails", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.gateRunner.line = "FACTORY_GATES: status=RED passed=1 failed=1 skipped=0 failed_gates=unit";
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", build());
    c.push("build", build());
    c.push("build", build()); // never reached: a second escalation would consume it
    expect(await c.step()).toBe("failed");
    expect(c.executor.models.filter(([s]) => s === "build").map(([, m]) => m)).toEqual([
      latestPricedModel("haiku"),
      latestPricedModel("sonnet"),
    ]);
    expect(c.executor.resumed.at(-1)?.failure).toContain("unit");
  });

  test("10e. a retry into the same failure with nothing changed is refused, and --force runs it (#86)", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.gateRunner.line = "FACTORY_GATES: status=RED passed=1 failed=1 skipped=0 failed_gates=unit";
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", build());
    c.push("build", build()); // the red gate reruns once on sonnet
    expect(await c.step()).toBe("failed");
    c.push("build", build());
    c.push("build", build());
    c.github.say(1, "/factory retry");
    expect(await c.step()).toBe("failed");
    expect(c.state.getRun("acme/widgets", 1)!.reason).toStartWith("build attempt 4: the change refused by gate:unit");
    const runs = c.state.listStageRuns("acme/widgets", { issue: 1 }).length;
    c.github.say(1, "/factory retry");
    expect(await c.step()).toBe("waiting");
    expect(c.state.listStageRuns("acme/widgets", { issue: 1 }).length).toBe(runs);
    expect(labels(c.github, 1)).toEqual([LABEL.failed]);
    expect(c.github.issues.get(1)!.comments.at(-1)!.body).toStartWith(
      "cause unchanged: build: the change refused by gate:unit",
    );
    expect(await c.step()).toBe("waiting");
    expect(c.state.listStageRuns("acme/widgets", { issue: 1 }).length).toBe(runs);
    expect(c.github.issues.get(1)!.comments.filter((x) => x.body.startsWith("cause unchanged")).length).toBe(1);
    c.gateRunner.line = "FACTORY_GATES: status=GREEN passed=2 failed=0 skipped=0 failed_gates=-";
    c.push("build", build());
    c.push("verify", verdict("pass"));
    c.push("pr", pr());
    c.github.say(1, "/factory retry --force");
    expect(await c.step()).toBe("shipped");
    done(c);
  });

  test("10f. an edited issue body lets the same retry run again (#86)", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", {}, { exitCode: 1, killedReason: "timed out after 15 minutes" });
    expect(await c.step()).toBe("failed");
    c.push("triage", {}, { exitCode: 1, killedReason: "timed out after 15 minutes" });
    c.github.say(1, "/factory retry");
    expect(await c.step()).toBe("failed");
    c.github.issues.get(1)!.body = "do the thing, in smaller steps";
    c.push("triage", {}, { exitCode: 1, killedReason: "timed out after 15 minutes" });
    c.github.say(1, "/factory retry");
    expect(await c.step()).toBe("failed");
    expect(c.state.listStageRuns("acme/widgets", { issue: 1 }).length).toBe(3);
    done(c);
  });

  test("10b. an operator takeover mid-build parks needs-human; retry resumes at build and the PR says so", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", {}, { exitCode: 143, killedReason: OPERATOR_TAKEOVER });
    expect(await c.step()).toBe("needs-human");
    expect(labels(c.github, 1)).toEqual([LABEL.needsHuman]);
    expect(c.state.getRun("acme/widgets", 1)!.reason).toBe(OPERATOR_TAKEOVER);
    expect(c.github.issues.get(1)!.comments.at(-1)!.body).toContain("Taken over by an operator during build");
    build_to_pr(c);
    c.github.say(1, "/factory retry");
    expect(await c.step()).toBe("shipped");
    const body = c.github.createdPrs[0]!.body;
    expect(body).toContain("## Factory run");
    expect(body).toContain("- build: taken over by an operator");
    expect(body).toContain("- 1 `/factory retry`");
    done(c);
  });

  test("10d. a retry that parks again is not replayed: one retry runs once, and an uncertain verdict is posted", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", build());
    c.push("verify", verdict("uncertain"));
    expect(await c.step()).toBe("needs-human");
    expect(c.github.issues.get(1)!.comments.at(-1)!.body).toContain("<!-- factory:verdict");
    expect(c.state.listStageRuns("acme/widgets", { issue: 1 }).find((r) => r.stage === "verify")!.verdict).toBe(
      "uncertain",
    );
    c.push("verify", verdict("uncertain"));
    c.github.say(1, "/factory retry");
    expect(await c.step()).toBe("needs-human");
    const runs = c.state.listStageRuns("acme/widgets", { issue: 1 }).length;
    await c.step();
    expect(c.state.listStageRuns("acme/widgets", { issue: 1 }).length).toBe(runs);
    expect(labels(c.github, 1)).toEqual([LABEL.needsHuman]);
    expect(c.github.issues.get(1)!.comments.some((x) => x.body.includes("Retrying from verify"))).toBe(true);
    done(c);
  });

  test("10c. config prRunSummary false leaves the PR body as the agent wrote it", async () => {
    const c = setup([LABEL.ready], { prRunSummary: false });
    c.state.setToggle("auto_approve_low_risk", true);
    happy(c);
    expect(await c.step()).toBe("shipped");
    expect(c.github.createdPrs[0]!.body).not.toContain("## Factory run");
    done(c);
  });

  test("11. a third verify reject parks as needs-human", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.push("triage", triage());
    c.push("plan", plan("low"));
    for (let i = 0; i < 3; i++) {
      c.push("build", build());
      c.push("verify", verdict("reject"));
    }
    expect(await c.step()).toBe("needs-human");
    expect(c.state.getRun("acme/widgets", 1)!.reason).toContain("rejected 3 times");
    done(c);
  });

  test("11c. a rebuild by an agent that kept no session is still told why it came back", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", build(), { sessionId: "" });
    c.push("verify", { ...verdict("reject"), "verdict-comment.md": "<!-- factory:verdict v1 -->\nstill throws" });
    c.push("build", build());
    c.push("verify", verdict("pass"));
    c.push("pr", pr());
    expect(await c.step()).toBe("shipped");
    expect(c.executor.resumed[4]).toEqual({ failure: "<!-- factory:verdict v1 -->\nstill throws" });
    done(c);
  });

  test("11b. a rebuild after a reject resumes the last build session, told why it came back", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", build(), { sessionId: "s-build-1" });
    c.push(
      "verify",
      { ...verdict("reject"), "verdict-comment.md": "<!-- factory:verdict v1 -->\nthe empty list still throws" },
      { sessionId: "s-verify-1" },
    );
    c.push("build", build(), { sessionId: "s-build-2" });
    c.push("verify", verdict("pass"));
    c.push("pr", pr());
    expect(await c.step()).toBe("shipped");
    // Runs in order: triage, plan, build, verify, the rebuild, verify, pr.
    expect(c.executor.resumed[4]).toEqual({
      sessionId: "s-build-1",
      failure: "<!-- factory:verdict v1 -->\nthe empty list still throws",
    });
    // Only the rebuild resumes: triage, plan, the first build and every verify start fresh.
    expect(c.executor.resumed.filter(Boolean)).toHaveLength(1);
    // The rebuild is told of the reject, so it runs a tier up; the first build is not.
    expect(c.executor.rejects.filter(([s]) => s === "build")).toEqual([
      ["build", undefined],
      ["build", 1],
    ]);
    done(c);
  });

  test("12. a protected path in the diff parks before any push", async () => {
    const c = setup([LABEL.ready], { protectedPaths: ["src/auth/**"] });
    c.state.setToggle("auto_approve_low_risk", true);
    c.git.changed = ["src/auth/token.ts"];
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", build());
    expect(await c.step()).toBe("needs-human");
    expect(c.git.pushed).toEqual([]);
    expect(c.state.getRun("acme/widgets", 1)!.reason).toContain("src/auth/token.ts");
    done(c);
  });

  test("12b. a normal build still cannot touch .claude/**, even with the default empty protectedPaths", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.git.changed = [".claude/skills/factory-build/SKILL.md"];
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", build());
    expect(await c.step()).toBe("needs-human");
    expect(c.git.pushed).toEqual([]);
    expect(c.state.getRun("acme/widgets", 1)!.reason).toContain(".claude/skills/factory-build/SKILL.md");
    done(c);
  });

  test("13. a killed stage fails with the kill reason", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage(), { exitCode: 1, killedReason: "timed out after 15 minutes" });
    expect(await c.step()).toBe("failed");
    expect(c.state.getRun("acme/widgets", 1)!.reason).toBe(
      "triage attempt 1: timed out after 15 minutes; spent $0.01 on this issue",
    );
    done(c);
  });

  test("14. a refused tool call fails with the tool and path named", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", {}, { exitCode: 0, permissionDenials: ["Write .factory/runs/issue-1/triage.json"] });
    expect(await c.step()).toBe("failed");
    expect(c.state.getRun("acme/widgets", 1)!.reason).toContain("Write .factory/runs/issue-1/triage.json");
    done(c);
  });

  test("14i. a refused part of a compound command is named with its source, attempt and spend (#91)", async () => {
    const c = setup([LABEL.ready]);
    const target = "git status --short; npm ls zod undici 2>&1 | head -20";
    c.push("triage", {}, { exitCode: 0, refusals: [{ tool: "Bash", target, by: "hook:guard-paths" }] });
    expect(await c.step()).toBe("failed");
    const reason = c.state.getRun("acme/widgets", 1)!.reason!;
    expect(reason).toBe(
      "triage attempt 1: `npm ls zod undici 2>&1` refused by hook:guard-paths; spent $0.01 on this issue",
    );
    const comment = c.github.issues.get(1)!.comments.at(-1)!.body;
    expect(comment).toContain("Failed: triage attempt 1: `npm ls zod undici 2>&1` refused by hook:guard-paths");
    expect(comment).not.toContain("spent");
    done(c);
  });

  test("14b. a step that reports outcome blocked parks as needs-human with its summary", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ outcome: "blocked", summary: "Need the payment provider's sandbox key" }));
    expect(await c.step()).toBe("needs-human");
    expect(labels(c.github, 1)).toEqual([LABEL.needsHuman]);
    expect(c.state.getRun("acme/widgets", 1)!.reason).toBe("Need the payment provider's sandbox key");
    done(c);
  });

  test("14d. verify re-runs the gates when gate.json describes a different tree", async () => {
    const same = setup(["factory:ready"]);
    happy(same);
    await same.step();
    expect(same.gateRunner.runs).toBe(1);

    const moved = setup(["factory:ready"]);
    moved.git.trees = ["built", "amended"];
    happy(moved);
    await moved.step();
    expect(moved.gateRunner.runs).toBe(2);
  });

  test("14f. a red gate re-run before verify sends the issue back to build, and is capped", async () => {
    const GREEN = "FACTORY_GATES: status=GREEN passed=2 failed=0 skipped=0 failed_gates=-";
    const RED = "FACTORY_GATES: status=RED passed=1 failed=1 skipped=0 failed_gates=unit";
    const back = setup(["factory:ready"]);
    back.git.trees = ["built", "amended"];
    back.gateRunner.next = [GREEN, RED];
    happy(back);
    back.push("build", build());
    back.push("verify", verdict("pass"));
    back.push("pr", pr());
    expect(await back.step()).toBe("shipped");
    expect(back.state.listStageRuns("acme/widgets", { issue: 1 }).map((r) => r.stage)).toEqual([
      "triage",
      "plan",
      "build",
      "build",
      "verify",
      "pr",
    ]);

    const capped = setup(["factory:ready"]);
    capped.git.trees = ["a", "b", "c", "d", "e", "f"];
    capped.gateRunner.next = [GREEN, RED, GREEN, RED, GREEN, RED];
    capped.push("triage", triage());
    capped.push("plan", plan("low"));
    for (let i = 0; i < 3; i++) capped.push("build", build());
    expect(await capped.step()).toBe("failed");
    expect(capped.state.getRun("acme/widgets", 1)!.reason).toContain("before verify");
    expect(capped.state.listStageRuns("acme/widgets", { issue: 1 }).some((r) => r.stage === "verify")).toBe(false);
  });

  test("14g. the runner counts build and verify rounds, whatever the agent wrote", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", build());
    c.push("verify", verdict("reject"));
    c.push("build", build());
    c.push("verify", verdict("pass"));
    c.push("pr", pr());
    expect(await c.step()).toBe("shipped");
    const markers = c.github.issues
      .get(1)!
      .comments.map((m) => m.body)
      .join("\n");
    expect(markers).toContain('"rounds":2,"findings"');
    expect(markers).toContain('"rounds":1,"findings"');
    done(c);
  });

  test("14h. a tool-free re-check drops unsupported findings, and a reject left with none goes to a human", async () => {
    const finding = (what: string) => ({ severity: "must", confidence: 4, what });
    const rejected = (findings: unknown[]) => ({
      "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
      "verdict.json": JSON.stringify({ result: "reject", rounds: 1, findings }),
    });
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    const asked: unknown[] = [];
    (c.deps as { rechecker?: unknown }).rechecker = {
      supported: async (f: unknown[]) => (asked.push(f), [] as number[]),
    };
    c.push("triage", triage());
    c.push("plan", plan("low"));
    c.push("build", build());
    c.push("verify", rejected([finding("invented bug")]));
    expect(await c.step()).toBe("needs-human");
    expect(asked).toHaveLength(1);
    const body = c.github.issues
      .get(1)!
      .comments.map((m) => m.body)
      .join("\n");
    expect(body).toContain("does not support 1 finding(s)");
    expect(body).toContain("- invented bug");
    // A supported finding stands: the reject still sends the issue back to build.
    const d = setup([LABEL.ready]);
    d.state.setToggle("auto_approve_low_risk", true);
    (d.deps as { rechecker?: unknown }).rechecker = { supported: async () => [0] };
    d.push("triage", triage());
    d.push("plan", plan("low"));
    d.push("build", build());
    d.push("verify", rejected([finding("real bug")]));
    d.push("build", build());
    d.push("verify", verdict("pass"));
    d.push("pr", pr());
    expect(await d.step()).toBe("shipped");
    expect(d.github.seenLabels.has(LABEL.building)).toBe(true);
    done(c);
    done(d);
  });

  test("14e. triage refuses an issue another open PR already closes, and spends no tokens", async () => {
    const c = setup(["factory:ready"]);
    c.github.prs.push({
      number: 9,
      url: "u",
      state: "open",
      headRefName: "someone/fix",
      isDraft: false,
      closingIssuesReferences: [{ number: c.n }],
    });
    happy(c);
    expect(await c.step()).toBe("needs-human");
    expect(
      (c.state as unknown as { db: { query(q: string): { all(): unknown[] } } }).db
        .query("SELECT 1 FROM stage_runs")
        .all(),
    ).toHaveLength(0);
  });

  test("14c. outcome failed fails the run; an outcome complete does not hide a non-zero exit", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ outcome: "failed", summary: "cannot reproduce" }));
    expect(await c.step()).toBe("failed");
    expect(c.state.getRun("acme/widgets", 1)!.reason).toBe("cannot reproduce");
    const d = setup([LABEL.ready]);
    d.push("triage", triage({ outcome: "complete", summary: "ok" }), { exitCode: 1 });
    expect(await d.step()).toBe("failed");
    done(c);
    done(d);
  });

  test("14d. an unknown field in any stage JSON fails the stage and names the field", async () => {
    const c = setup([LABEL.ready]);
    c.push("triage", triage({ dispositon: "proceed" }));
    expect(await c.step()).toBe("failed");
    expect(c.state.getRun("acme/widgets", 1)!.reason).toBe(
      'triage attempt 1: triage.json has unknown field "dispositon"; spent $0.01 on this issue',
    );
    const d = setup([LABEL.ready]);
    d.state.setToggle("auto_approve_low_risk", true);
    d.push("triage", triage());
    d.push("plan", plan("low", { file: ["src/b.ts"] }));
    expect(await d.step()).toBe("failed");
    expect(d.state.getRun("acme/widgets", 1)!.reason).toBe(
      'plan attempt 1: plan.json has unknown field "file"; spent $0.02 on this issue',
    );
    done(c);
    done(d);
  });
});

describe("in-review and claim paths", () => {
  async function shipped() {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    happy(c);
    await c.step();
    return c;
  }

  test("15. /factory revise on the issue rebuilds and updates the same PR", async () => {
    const c = await shipped();
    expect(await c.step()).toBe("waiting");
    build_to_pr(c);
    c.github.say(1, "/factory revise rename the helper");
    expect(await c.step()).toBe("shipped");
    expect(c.github.createdPrs).toHaveLength(1);
    // Back to draft for the rebuild, then ready again.
    expect(c.github.readyCalls).toEqual([
      ["factory/issue-1", true],
      ["factory/issue-1", false],
      ["factory/issue-1", true],
    ]);
    expect(c.github.prs[0]!.isDraft).toBe(false);
    expect(await c.step()).toBe("waiting"); // handled once, not re-triggered
    done(c);
  });

  test("16. /factory revise as a PR comment or review rebuilds the same PR", async () => {
    const c = await shipped();
    c.github.sayOnPr("/factory revise handle negative amounts", "NONE");
    expect(await c.step()).toBe("waiting"); // untrusted
    build_to_pr(c);
    c.github.sayOnPr("/factory revise handle negative amounts");
    expect(await c.step()).toBe("shipped");
    expect(c.github.createdPrs).toHaveLength(1);
    expect(await c.step()).toBe("waiting");
    done(c);
  });

  test("17. a lost claim removes factory:ready and comments once", async () => {
    const c = setup([LABEL.ready]);
    c.git.claimResult = false;
    expect(await c.step()).toBe("lost-claim");
    expect(labels(c.github, 1)).toEqual([]);
    expect(await c.step()).toBe("waiting");
    expect(c.github.issues.get(1)!.comments).toHaveLength(1);
    done(c);
  });

  test("20. recoverInFlight re-drives an issue left in factory:building", async () => {
    const c = setup([LABEL.building]);
    c.github.issues.get(1)!.comments = [
      {
        id: 1,
        author: "factory-bot",
        authorAssociation: "OWNER",
        body: `<!-- factory:data ${JSON.stringify({ stage: "plan", json: { risk: "low" } })} -->`,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    build_to_pr(c);
    expect(await recoverInFlight(c.deps, c.config)).toEqual([1]);
    expect(labels(c.github, 1)).toEqual([LABEL.inReview]);
    done(c);
  });

  test("20a. recovery leaves an in-flight issue that needs a capability this machine lacks", async () => {
    const c = setup([LABEL.building, "needs:gpu"]);
    expect(await recoverInFlight(c.deps, c.config)).toEqual([]);
    expect(labels(c.github, 1)).toEqual([LABEL.building, "needs:gpu"]);
    done(c);
  });

  test("20b. with leases, recovery leaves an issue a live worker holds and reclaims one whose worker died", async () => {
    const c = setup([LABEL.building]);
    c.github.issues.get(1)!.comments = [
      {
        id: 1,
        author: "factory-bot",
        authorAssociation: "OWNER",
        body: `<!-- factory:data ${JSON.stringify({ stage: "plan", json: { risk: "low" } })} -->`,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    build_to_pr(c);
    const port = new FakeLeases();
    const deps = { ...c.deps, leases: { port, holder: "me", held: new Map() } };
    await port.acquire("1", "other", 30_000, Date.now());
    await recoverInFlight(deps, c.config);
    expect(labels(c.github, 1)).toEqual([LABEL.building]);
    port.table.set("1", { holder: "other", expiresAt: Date.now() - 1 });
    await recoverInFlight(deps, c.config);
    expect(labels(c.github, 1)).toEqual([LABEL.inReview]);
    expect(port.log.at(-1)).toBe("release 1 me");
    done(c);
  });

  test("21. STOP_IF stops new pickups but not approvals on existing runs", async () => {
    const c = setup([LABEL.ready], { maxOpenFactoryPrs: 3 });
    for (const [i, head] of ["factory/issue-90", "factory/issue-91", "factory/issue-92"].entries()) {
      c.github.prs.push({ number: 90 + i, url: "u", state: "open", headRefName: head, isDraft: true });
    }
    const waiting = baseIssue(2, [LABEL.awaitingApproval]);
    waiting.comments = [
      {
        id: 5,
        author: "factory-bot",
        authorAssociation: "OWNER",
        body: "<!-- factory:plan v1 rev=1 -->",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    c.github.issues.set(2, waiting);
    c.github.say(2, "/factory cancel");
    const result = await pollOnce(c.deps, c.config);
    expect(result.paused).toBe(true);
    expect(result.processed).toEqual([2]);
    expect(labels(c.github, 1)).toEqual([LABEL.ready]);
    done(c);
  });
});

// checkMergePolicy (watch.ts), wired into resumeInReview: a per-poll,
// non-blocking check on an in-review PR. `off` is DEFAULT_CONFIG.merge.policy,
// so most of the scenario suite above already proves it never touches
// mergePr; these tests exercise the other two policies explicitly.
describe("merge policy on an in-review PR", () => {
  async function readyForMerge(c: Ctx) {
    c.state.setToggle("auto_approve_low_risk", true);
    happy(c);
    await c.step();
    const pr = c.github.prs[0]!;
    c.github.queuePrStatus(pr.number, {
      state: "open",
      headRefOid: "sha1",
      closingIssuesReferences: [{ number: 1 }],
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    });
    c.github.queueMergeReadiness(pr.number, {
      state: "open",
      isDraft: false,
      baseRefName: c.config.base,
      headRefOid: "sha1",
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      hasUnresolvedReviewThreads: false,
      changesRequestedStale: false,
    });
    return pr;
  }

  test("23. policy off never calls mergePr or checks readiness at all, even on a fully green, fully approved PR", async () => {
    const c = setup([LABEL.ready]);
    await readyForMerge(c);
    expect(c.config.merge.policy).toBe("off");
    const before = c.github.issues.get(1)!.comments.length;
    expect(await c.step()).toBe("waiting");
    expect(c.github.merged).toEqual([]);
    // Not just "never merges": the guard skips the check entirely, so no
    // audit comment (a "refuse: policy-not-auto") gets posted either.
    expect(c.github.issues.get(1)!.comments.length).toBe(before);
    done(c);
  });

  test("24. policy auto merges a fully eligible PR exactly once", async () => {
    const c = setup([LABEL.ready], { merge: { policy: "auto", autoPaths: [], maxFiles: 10, maxLines: 200 } });
    const pr = await readyForMerge(c);
    const bus = new EventBus({ store: c.state, sinks: [], source: "s", autoDeliver: false });
    const deps = { ...c.deps, bus };
    expect(await advanceIssue(deps, c.config, c.github.issues.get(1)!)).toBe("shipped");
    expect(c.github.merged).toEqual([{ repo: c.config.repo, prNumber: pr.number, headSha: "sha1" }]);
    const comments = c.github.issues.get(1)!.comments;
    expect(comments.some((cm) => cm.body.includes("<!-- factory:merge-policy:sha1 -->"))).toBe(true);
    expect(labels(c.github, 1)).not.toContain(LABEL.inReview);
    // The factory's own merge is not read back as a human one on a later poll.
    c.github.issues.get(1)!.labels.push({ name: LABEL.inReview });
    expect(await advanceIssue(deps, c.config, c.github.issues.get(1)!)).toBe("waiting");
    expect(mergedEvents(c).map((e) => e.by)).toEqual(["factory"]);
    done(c);
  });

  test("28. policy off: a PR a human merged closes the issue, emits pr.merged by human and runs retro, once", async () => {
    const c = setup([LABEL.ready]);
    const pr = await readyForMerge(c);
    const bus = new EventBus({ store: c.state, sinks: [], source: "s", autoDeliver: false });
    const deps = { ...c.deps, bus };
    expect(await advanceIssue(deps, c.config, c.github.issues.get(1)!)).toBe("waiting");
    (pr as { state: string }).state = "merged";
    expect(await advanceIssue(deps, c.config, c.github.issues.get(1)!)).toBe("shipped");
    expect(c.github.closed).toEqual([1]);
    expect(labels(c.github, 1)).not.toContain(LABEL.inReview);
    expect(mergedEvents(c)).toEqual([{ repo: c.config.repo, issue: 1, pr: pr.number, by: "human" }]);
    expect(c.state.listRetros(c.config.repo).map((r) => r.outcome)).toEqual(["merged"]);
    // The branch keeps the work; the workspace goes once the PR merged.
    expect(existsSync(join(c.workspacesDir, "issue-1"))).toBe(false);
    // A second poll that still lists the issue does nothing: the marker comment guards it.
    c.github.issues.get(1)!.labels.push({ name: LABEL.inReview });
    const before = c.github.issues.get(1)!.comments.length;
    expect(await advanceIssue(deps, c.config, c.github.issues.get(1)!)).toBe("waiting");
    expect(c.github.closed).toEqual([1]);
    expect(mergedEvents(c)).toHaveLength(1);
    expect(c.state.listRetros(c.config.repo)).toHaveLength(1);
    expect(c.github.issues.get(1)!.comments.length).toBe(before);
    expect(c.github.merged).toEqual([]);
    done(c);
  });

  test("29. a PR closed without merging is not a merge", async () => {
    const c = setup([LABEL.ready]);
    const pr = await readyForMerge(c);
    const bus = new EventBus({ store: c.state, sinks: [], source: "s", autoDeliver: false });
    (pr as { state: string }).state = "closed";
    expect(await advanceIssue({ ...c.deps, bus }, c.config, c.github.issues.get(1)!)).toBe("waiting");
    expect(c.github.closed).toEqual([]);
    expect(labels(c.github, 1)).toContain(LABEL.inReview);
    expect(mergedEvents(c)).toEqual([]);
    expect(c.state.listRetros(c.config.repo)).toEqual([]);
    done(c);
  });

  test("25. policy dry-run posts the audit comment but never merges", async () => {
    const c = setup([LABEL.ready], { merge: { policy: "dry-run", autoPaths: [], maxFiles: 10, maxLines: 200 } });
    await readyForMerge(c);
    expect(await c.step()).toBe("waiting");
    expect(c.github.merged).toEqual([]);
    const comments = c.github.issues.get(1)!.comments;
    expect(comments.some((cm) => cm.body.includes("Merge policy: **dry-run**"))).toBe(true);
    done(c);
  });

  test("26. a second poll on an unchanged head does not re-post the audit comment", async () => {
    const c = setup([LABEL.ready], { merge: { policy: "dry-run", autoPaths: [], maxFiles: 10, maxLines: 200 } });
    await readyForMerge(c);
    await c.step();
    const before = c.github.issues.get(1)!.comments.length;
    await c.step();
    expect(c.github.issues.get(1)!.comments.length).toBe(before);
    done(c);
  });

  test("27. a file under protectedPaths never qualifies for auto-merge, whatever autoPaths says", async () => {
    const c = setup([LABEL.ready], {
      protectedPaths: ["src/secrets.ts"],
      merge: { policy: "auto", autoPaths: ["src/**"], maxFiles: 10, maxLines: 200 },
    });
    c.git.diffStatOverride = [{ path: "src/secrets.ts", additions: 1, deletions: 0 }];
    await readyForMerge(c);
    expect(await c.step()).toBe("waiting");
    expect(c.github.merged).toEqual([]);
    done(c);
  });
});

// The README promises `/factory cancel` closes the run from every waiting
// state. One row per state; a new waiting label without a row here fails the
// coverage check below.
describe("cancel from every waiting state", () => {
  const reach: Record<string, (c: Ctx) => Promise<void>> = {
    [LABEL.needsInfo]: async (c) => {
      c.push("triage", { ...triage({ disposition: "needs-info" }), ...question() });
      await c.step();
    },
    [LABEL.awaitingApproval]: async (c) => {
      c.push("triage", triage({ risk: "medium" }));
      c.push("plan", plan("medium"));
      await c.step();
    },
    [LABEL.needsHuman]: async (c) => {
      c.push("triage", triage({ disposition: "refused" }));
      await c.step();
    },
    [LABEL.failed]: async (c) => {
      c.gateRunner.line = "FACTORY_GATES: status=RED passed=1 failed=1 skipped=0 failed_gates=unit";
      c.state.setToggle("auto_approve_low_risk", true);
      happy(c);
      c.push("build", build());
      await c.step();
    },
    [LABEL.inReview]: async (c) => {
      c.state.setToggle("auto_approve_low_risk", true);
      happy(c);
      await c.step();
    },
  };

  for (const [label, getThere] of Object.entries(reach)) {
    test(`22. /factory cancel from ${label} closes the issue and the PR`, async () => {
      const c = setup([LABEL.ready]);
      await getThere(c);
      expect(labels(c.github, 1)).toEqual([label]);
      c.github.say(1, "/factory cancel");
      expect(await c.step()).toBe("cancelled");
      expect(labels(c.github, 1)).toEqual([]);
      expect(c.github.closed).toEqual([1]);
      expect(c.github.prs.every((p) => p.state === "closed")).toBe(true);
      expect(existsSync(join(c.workspacesDir, "issue-1"))).toBe(false);
      expect(c.state.getRun("acme/widgets", 1)!.status).toBe("cancelled");
      done(c);
    });
  }

  test("22b. an untrusted /factory cancel is ignored", async () => {
    const c = setup([LABEL.ready]);
    await reach[LABEL.awaitingApproval]!(c);
    c.github.say(1, "/factory cancel", "NONE");
    expect(await c.step()).toBe("waiting");
    expect(c.github.closed).toEqual([]);
    done(c);
  });

  test("22c. every waiting label has a cancel scenario", () => {
    const waiting = [LABEL.needsInfo, LABEL.awaitingApproval, LABEL.needsHuman, LABEL.failed, LABEL.inReview];
    expect(Object.keys(reach).sort()).toEqual([...waiting].sort());
  });
});

// Plan v2.7.0 item 8: proof:check exists so Markdown-only work (a blog post,
// a docs page) is never forced through "build writes a failing test first".
// The runner reads proof off plan.json and never branches on it itself (that
// branching is the skills' job), so this pins the property that a
// proof:check plan naming no test file still reaches shipped like any other.
describe("proof: check ships markdown-only work with no test file", () => {
  test("23. a blog-post plan proved by a prose lint ships with no test file anywhere in its artifact", async () => {
    const c = setup([LABEL.ready]);
    c.state.setToggle("auto_approve_low_risk", true);
    c.push("triage", triage({ type: "docs", gate_level: "npm run check-prose" }));
    c.push("plan", plan("low", { proof: "check", files: ["content/blog/2026-09-27-launch.md"] }));
    build_to_pr(c);
    expect(await c.step()).toBe("shipped");
    const planJson = JSON.parse(readFileSync(join(c.workspacesDir, "issue-1", runDir(1), "plan.json"), "utf8"));
    expect(planJson.proof).toBe("check");
    expect(planJson.files.some((f: string) => /test|spec/i.test(f))).toBe(false);
    done(c);
  });
});

// blockers.ts: the "Blocked by" line on a ready issue's body gates it out of
// pollOnce's candidate list until every referenced issue is closed, then
// promotes it back to ready the same poll its last blocker clears.
describe("blocker gate", () => {
  test("24. a ready issue blocked by an open issue demotes, then promotes and ships once its blocker closes", async () => {
    const c = setup([LABEL.ready]);
    c.github.issues.get(1)!.body = "Blocked by: #2";
    c.github.issues.set(2, baseIssue(2, []));

    let result = await pollOnce(c.deps, c.config);
    expect(result.processed).toEqual([]);
    expect(labels(c.github, 1)).toEqual([LABEL.blocked]);
    expect(c.github.issues.get(1)!.comments).toHaveLength(1);
    expect(c.github.issues.get(1)!.comments[0]!.body).toContain("#2");

    // Polling again with the blocker still open must not comment a second time.
    result = await pollOnce(c.deps, c.config);
    expect(c.github.issues.get(1)!.comments).toHaveLength(1);

    c.github.issues.get(2)!.state = "CLOSED";
    c.state.setToggle("auto_approve_low_risk", true);
    happy(c);
    result = await pollOnce(c.deps, c.config);
    expect(result.processed).toEqual([1]);
    expect(labels(c.github, 1)).toEqual([LABEL.inReview]);
    done(c);
  });

  test("24b. a blocker closed as not planned still blocks", async () => {
    const c = setup([LABEL.ready]);
    c.github.issues.get(1)!.body = "Blocked by: #2";
    const blocker = baseIssue(2, []);
    blocker.state = "CLOSED";
    blocker.stateReason = "NOT_PLANNED";
    c.github.issues.set(2, blocker);

    const result = await pollOnce(c.deps, c.config);
    expect(result.processed).toEqual([]);
    expect(labels(c.github, 1)).toEqual([LABEL.blocked]);
    done(c);
  });
});

test("every state and parked label is reached by a scenario", () => {
  const unreached = [...STATE_LABELS, ...PARKED_LABELS].filter((l) => !seen.has(l));
  expect(unreached).toEqual([]);
});

// A parked run whose PR a human merged, or whose issue a human closed: before
// this, only in-review checked for a merge, and a closed issue left every
// label list, so the run stayed parked with its tmux window open forever.
describe("parked runs ended outside the factory", () => {
  function parked(label: string, status: "needs-human" | "needs-info" | "awaiting-approval") {
    const c = setup([label]);
    c.state.upsertRun({ issue: 1, repo: c.config.repo, title: "t", stage: "verify", status });
    mkdirSync(join(c.workspacesDir, "issue-1"), { recursive: true });
    const closedViews: number[] = [];
    const deps = { ...c.deps, view: { show: async () => {}, close: async (n: number) => void closedViews.push(n) } };
    const mergePr = () =>
      c.github.prs.push({ number: 7, url: "u", state: "merged", headRefName: c.git.branchName(1), isDraft: false });
    return { c, deps, closedViews, mergePr };
  }

  for (const [label, status] of [
    [LABEL.needsHuman, "needs-human"],
    [LABEL.needsInfo, "needs-info"],
    [LABEL.awaitingApproval, "awaiting-approval"],
    [LABEL.failed, "needs-human"],
  ] as const) {
    test(`a ${label} run whose PR a human merged ships, drops its labels and workspace and closes its window`, async () => {
      const { c, deps, closedViews, mergePr } = parked(label, status);
      mergePr();
      expect(await advanceIssue(deps, c.config, c.github.issues.get(1)!)).toBe("shipped");
      expect(labels(c.github, 1)).not.toContain(label);
      expect(c.github.closed).toEqual([1]);
      expect(c.state.getRun(c.config.repo, 1)?.status).toBe("shipped");
      expect(existsSync(join(c.workspacesDir, "issue-1"))).toBe(false);
      expect(closedViews).toEqual([1]);
      done(c);
    });
  }

  test("a parked run whose closed issue had its PR merged is recorded shipped by the poll", async () => {
    const { c, deps, closedViews, mergePr } = parked(LABEL.needsHuman, "needs-human");
    mergePr();
    const issue = c.github.issues.get(1)!;
    issue.labels = [];
    issue.state = "CLOSED";
    const r = await pollOnce(deps, c.config);
    expect(r.processed).toEqual([1]);
    expect(c.state.getRun(c.config.repo, 1)?.status).toBe("shipped");
    expect(existsSync(join(c.workspacesDir, "issue-1"))).toBe(false);
    expect(closedViews).toEqual([1]);
    // The next poll finds nothing parked left to end.
    expect((await pollOnce(deps, c.config)).processed).toEqual([]);
    done(c);
  });

  test("a parked run whose issue was closed without a merge is cancelled, not shipped", async () => {
    const { c, deps, closedViews } = parked(LABEL.needsHuman, "needs-human");
    const issue = c.github.issues.get(1)!;
    issue.labels = [];
    issue.state = "CLOSED";
    expect((await pollOnce(deps, c.config)).processed).toEqual([1]);
    expect(c.state.getRun(c.config.repo, 1)?.status).toBe("cancelled");
    expect(mergedEvents(c)).toEqual([]);
    expect(existsSync(join(c.workspacesDir, "issue-1"))).toBe(false);
    expect(closedViews).toEqual([1]);
    done(c);
  });

  test("a parked run whose issue is still open stays parked", async () => {
    const { c, deps, closedViews } = parked(LABEL.needsHuman, "needs-human");
    c.github.issues.get(1)!.labels = [];
    expect((await pollOnce(deps, c.config)).processed).toEqual([]);
    expect(c.state.getRun(c.config.repo, 1)?.status).toBe("needs-human");
    expect(existsSync(join(c.workspacesDir, "issue-1"))).toBe(true);
    expect(closedViews).toEqual([]);
    done(c);
  });
});
