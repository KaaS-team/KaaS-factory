import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentIdFor } from "../src/cloud/cursor";
import { CloudError, type CloudProvider, type CloudRun } from "../src/cloud/port";
import { cloudLedger } from "../src/cloud/ledger";
import { mergeConfig } from "../src/config";
import { cloudAware, type CloudIo } from "../src/engine/cloud-build";
import { ALL_STEP_TYPES } from "../src/engine/registry";
import { STEP_TYPES, type StepCtx } from "../src/engine/steps";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub } from "./harness";

const tmpBase = join(import.meta.dir, ".tmp-cloud-build");
mkdirSync(tmpBase, { recursive: true });

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

class FakeCloud implements CloudProvider {
  readonly name = "cursor-cloud";
  launchCalls = 0;
  cancelCalls = 0;
  polls = 0;
  usageCost = 0;
  lastKey = "";
  runId = "cloud-run-1";
  finishAfterPolls = 2;
  launchError: CloudError | undefined;
  onPoll: (() => void) | undefined;

  async launch(i: import("../src/cloud/port").LaunchInput): Promise<CloudRun> {
    this.launchCalls += 1;
    this.lastKey = i.key;
    if (this.launchError) throw this.launchError;
    return { id: this.runId, status: "running" };
  }

  async poll(id: string): Promise<CloudRun> {
    this.polls += 1;
    this.onPoll?.();
    if (this.polls >= this.finishAfterPolls) return { id, status: "finished", summary: "built" };
    return { id, status: "running" };
  }

  async usage(): Promise<{ costUsd?: number }> {
    return { costUsd: this.usageCost };
  }

  async steer(): Promise<void> {}

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }
}

class CloudGit extends FakeGit {
  remoteSha = "aaa000";
  beforeSha = "aaa000";
  pullCalls = 0;
  pushCalls = 0;
  // False until a test says the branch already holds the issue's commits.
  prebuilt = false;

  override async hasCommits(): Promise<boolean> {
    return this.prebuilt;
  }

  override async remoteHeadSha(): Promise<string | undefined> {
    return this.remoteSha;
  }

  override async pullBranch(_worktreeDir: string, _issue: number) {
    this.pullCalls += 1;
    return { stdout: "", stderr: "", code: 0 };
  }

  override async changedFiles(): Promise<string[]> {
    return ["src/feature.ts"];
  }

  override async push(_worktreeDir: string, issue: number) {
    this.pushCalls += 1;
    return super.push(_worktreeDir, issue);
  }
}

function testIo(fake: FakeCloud, t0 = 1_000): CloudIo {
  let t = t0;
  return {
    secrets: { get: () => undefined },
    fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    sleep: async () => {
      t += 1;
    },
    now: () => t,
    pollMs: 1,
    orchestrate: true,
    provider: () => fake,
  };
}

function stepCtx(
  deps: StepCtx["deps"],
  config: ReturnType<typeof mergeConfig>,
  issue: ReturnType<typeof baseIssue>,
  worktree: string,
): StepCtx {
  return {
    deps,
    config,
    issue,
    worktree,
    ctx: { rejectRound: 0, questionRound: 0 },
    step: { id: "build", uses: "build", label: LABEL.ready, agent: "a", next: [] },
    workflow: {
      name: "planned-to-pr",
      limits: { rejects: 2, questions: 2 },
      steps: { build: { id: "build", uses: "build", label: LABEL.ready } },
      edges: [],
    },
  } as unknown as StepCtx;
}

function reserveCloud(state: FactoryState, repo: string, issue: number): void {
  cloudLedger(state, repo).reserve(issue, "cursor-cloud");
}

function worktreeDir(): string {
  const dir = mkdtempSync(join(tmpBase, "wt-"));
  roots.push(dir);
  mkdirSync(join(dir, ".factory", "runs", "issue-7"), { recursive: true });
  mkdirSync(join(dir, ".factory", "runs", "issue-3"), { recursive: true });
  return dir;
}

describe("cloud build step", () => {
  test("no reservation is local", async () => {
    let localRuns = 0;
    let fetchCalls = 0;
    const local = {
      agent: true,
      async run() {
        localRuns += 1;
        return { kind: "next" as const };
      },
    };
    const io: CloudIo = {
      secrets: { get: () => undefined },
      fetch: (async () => {
        fetchCalls += 1;
        return new Response("", { status: 500 });
      }) as unknown as typeof fetch,
      sleep: async () => {},
      now: () => 1,
      pollMs: 1,
    };
    const state = new FactoryState(":memory:");
    state.setToggle("orchestrate", true);
    const config = mergeConfig({ repo: "o/r", orchestrate: { enabled: true } });
    const sc = stepCtx(
      {
        state,
        git: new CloudGit(),
        gateRunner: new FakeGateRunner(),
        github: new FakeGitHub([]),
      } as unknown as StepCtx["deps"],
      config,
      baseIssue(1, [LABEL.ready]),
      worktreeDir(),
    );
    const out = await cloudAware(local, io).run(sc);
    expect(out.kind).toBe("next");
    expect(localRuns).toBe(1);
    expect(fetchCalls).toBe(0);
    state.close();
  });

  test("registry wraps build", () => {
    expect(ALL_STEP_TYPES.build).not.toBe(STEP_TYPES.build);
  });

  test("registry cloud path reaches a fake provider", async () => {
    const fake = new FakeCloud();
    const git = new CloudGit();
    fake.onPoll = () => {
      git.remoteSha = "bbb111";
    };
    const state = new FactoryState(":memory:");
    state.setToggle("orchestrate", true);
    const repo = "acme/widgets";
    const config = mergeConfig({ repo, base: "main", orchestrate: { enabled: true } });
    reserveCloud(state, repo, 7);
    state.upsertRun({ repo, issue: 7, title: "t", stage: "build", status: "running", config_hash: "x" });
    const issue = { ...baseIssue(7, [LABEL.ready]), body: "planned body", title: "Fix it" };
    const io = testIo(fake);
    Object.assign(ALL_STEP_TYPES, { build: cloudAware(STEP_TYPES.build!, io) });
    const sc = stepCtx(
      { state, git, gateRunner: new FakeGateRunner(), github: new FakeGitHub([issue]) } as unknown as StepCtx["deps"],
      config,
      issue,
      worktreeDir(),
    );
    const out = await ALL_STEP_TYPES.build!.run(sc);
    expect(out.kind).toBe("next");
    expect(fake.launchCalls).toBe(1);
    state.close();
  });

  test("gates graded locally", async () => {
    const fake = new FakeCloud();
    const git = new CloudGit();
    fake.onPoll = () => {
      git.remoteSha = "bbb111";
    };
    const gates = new FakeGateRunner();
    gates.line = "FACTORY_GATES: status=RED passed=0 failed=1 skipped=0 failed_gates=lint";
    const state = new FactoryState(":memory:");
    state.setToggle("orchestrate", true);
    const repo = "acme/widgets";
    const config = mergeConfig({ repo, base: "main", orchestrate: { enabled: true } });
    reserveCloud(state, repo, 7);
    state.upsertRun({ repo, issue: 7, title: "t", stage: "build", status: "running", config_hash: "x" });
    const sc = stepCtx(
      {
        state,
        git,
        gateRunner: gates,
        github: new FakeGitHub([baseIssue(7, [LABEL.ready])]),
      } as unknown as StepCtx["deps"],
      config,
      baseIssue(7, [LABEL.ready]),
      worktreeDir(),
    );
    const out = await cloudAware(STEP_TYPES.build!, testIo(fake)).run(sc);
    expect(out.kind).toBe("stop");
    if (out.kind !== "stop") throw new Error("expected stop");
    expect(out.outcome).toBe("failed");
    expect(git.pushCalls).toBe(0);
    state.close();
  });

  test("budget cancel", async () => {
    const fake = new FakeCloud();
    fake.usageCost = 9;
    fake.finishAfterPolls = 99;
    const state = new FactoryState(":memory:");
    state.setToggle("orchestrate", true);
    const repo = "acme/widgets";
    const config = mergeConfig({ repo, base: "main", orchestrate: { enabled: true, cost: { perRunUsd: 5 } } });
    reserveCloud(state, repo, 7);
    state.upsertRun({ repo, issue: 7, title: "t", stage: "build", status: "running", config_hash: "x" });
    const sc = stepCtx(
      {
        state,
        git: new CloudGit(),
        gateRunner: new FakeGateRunner(),
        github: new FakeGitHub([baseIssue(7, [LABEL.ready])]),
      } as unknown as StepCtx["deps"],
      config,
      baseIssue(7, [LABEL.ready]),
      worktreeDir(),
    );
    const out = await cloudAware(STEP_TYPES.build!, testIo(fake)).run(sc);
    expect(out.kind).toBe("stop");
    expect(fake.cancelCalls).toBe(1);
    state.close();
  });

  test("cost recorded", async () => {
    const fake = new FakeCloud();
    fake.usageCost = 3.5;
    const git = new CloudGit();
    fake.onPoll = () => {
      git.remoteSha = "bbb111";
    };
    const state = new FactoryState(":memory:");
    state.setToggle("orchestrate", true);
    const repo = "acme/widgets";
    const config = mergeConfig({ repo, base: "main", orchestrate: { enabled: true } });
    reserveCloud(state, repo, 7);
    state.upsertRun({ repo, issue: 7, title: "t", stage: "build", status: "running", config_hash: "x" });
    const sc = stepCtx(
      {
        state,
        git,
        gateRunner: new FakeGateRunner(),
        github: new FakeGitHub([baseIssue(7, [LABEL.ready])]),
      } as unknown as StepCtx["deps"],
      config,
      baseIssue(7, [LABEL.ready]),
      worktreeDir(),
    );
    await cloudAware(STEP_TYPES.build!, testIo(fake)).run(sc);
    const row = state.listStageRuns(repo, { issue: 7 })[0]!;
    expect(row.cost_usd).toBe(3.5);
    expect(row.agent).toBe("cursor-cloud");
    state.close();
  });

  test("nothing pushed", async () => {
    const fake = new FakeCloud();
    fake.finishAfterPolls = 1;
    const git = new CloudGit();
    git.remoteSha = "same000";
    git.beforeSha = "same000";
    const state = new FactoryState(":memory:");
    state.setToggle("orchestrate", true);
    const repo = "acme/widgets";
    const config = mergeConfig({ repo, base: "main", orchestrate: { enabled: true } });
    reserveCloud(state, repo, 7);
    state.upsertRun({ repo, issue: 7, title: "t", stage: "build", status: "running", config_hash: "x" });
    const github = new FakeGitHub([baseIssue(7, [LABEL.ready])]);
    const sc = stepCtx(
      { state, git, gateRunner: new FakeGateRunner(), github } as unknown as StepCtx["deps"],
      config,
      baseIssue(7, [LABEL.ready]),
      worktreeDir(),
    );
    await cloudAware(STEP_TYPES.build!, testIo(fake)).run(sc);
    const bodies = github.issues
      .get(7)!
      .comments.map((c) => c.body)
      .join("\n");
    expect(bodies.includes("without pushing commits")).toBe(true);
    state.close();
  });

  const run7 = async (
    fake: FakeCloud,
    git: CloudGit,
    orchestrate: Record<string, unknown> = { enabled: true },
    reserve: (state: FactoryState, repo: string) => Promise<void> | void = (state, repo) =>
      reserveCloud(state, repo, 7),
  ) => {
    const state = new FactoryState(":memory:");
    state.setToggle("orchestrate", true);
    const repo = "acme/widgets";
    const config = mergeConfig({ repo, base: "main", orchestrate });
    await reserve(state, repo);
    state.upsertRun({ repo, issue: 7, title: "t", stage: "build", status: "running", config_hash: "x" });
    const github = new FakeGitHub([baseIssue(7, [LABEL.ready])]);
    const issue = { ...baseIssue(7, [LABEL.ready]), body: "SECRET-SPEC-BODY ".repeat(2000) };
    const sc = stepCtx(
      { state, git, gateRunner: new FakeGateRunner(), github } as unknown as StepCtx["deps"],
      config,
      issue,
      worktreeDir(),
    );
    const result = await cloudAware(STEP_TYPES.build!, testIo(fake)).run(sc);
    const comments = github.issues
      .get(7)!
      .comments.map((c) => c.body)
      .join("\n");
    state.close();
    return { result, comments };
  };

  test("the launch carries the issue reference, not the issue body", async () => {
    const fake = new FakeCloud();
    let seen: import("../src/cloud/port").LaunchInput | undefined;
    const launch = fake.launch.bind(fake);
    fake.launch = async (i) => ((seen = i), launch(i));
    await run7(fake, new CloudGit());
    expect(seen!.issueRef).toBe("acme/widgets#7");
    expect(seen!.prompt).toContain("/repos/acme/widgets/issues/7");
    expect(seen!.prompt).not.toContain("SECRET-SPEC-BODY");
  });

  test("a prompt over the limit is refused before launch, naming size and limit", async () => {
    const fake = new FakeCloud();
    const { comments } = await run7(fake, new CloudGit(), { enabled: true, promptMaxBytes: 50 });
    expect(fake.launchCalls).toBe(0);
    expect(comments).toMatch(/bytes, over the limit of 50/);
  });

  test("a branch that already holds the commits skips the launch", async () => {
    const fake = new FakeCloud();
    const git = new CloudGit();
    git.prebuilt = true;
    await run7(fake, git);
    expect(fake.launchCalls).toBe(0);
    expect(git.pullCalls).toBe(1);
  });

  test("a runtime label reserves a slot at poll time and the build launches through it", async () => {
    const fake = new FakeCloud();
    const { reserveForPoll } = await import("../src/orchestrate/refill");
    let reserved: { issue: number; provider: string }[] | undefined;
    await run7(
      fake,
      new CloudGit(),
      { enabled: true, providers: { "cursor-cloud": { max: 1 } } },
      async (state, repo) => {
        const config = mergeConfig({ repo, orchestrate: { enabled: true, providers: { "cursor-cloud": { max: 1 } } } });
        const ready = [{ number: 7, body: "", labels: [{ name: "runtime:cursor-cloud" }] }];
        reserved = (await reserveForPoll({ state }, config, ready))?.reserved;
      },
    );
    expect(reserved).toEqual([{ issue: 7, provider: "cursor-cloud" }]);
    expect(fake.launchCalls).toBe(1);
  });

  test("a branch without commits launches", async () => {
    const fake = new FakeCloud();
    await run7(fake, new CloudGit());
    expect(fake.launchCalls).toBe(1);
  });

  test("neutral comment", async () => {
    const fake = new FakeCloud();
    fake.launchError = new CloudError("auth", "the cursor-cloud key is not set (CURSOR_API_KEY)");
    const state = new FactoryState(":memory:");
    state.setToggle("orchestrate", true);
    const repo = "acme/widgets";
    const config = mergeConfig({ repo, orchestrate: { enabled: true } });
    reserveCloud(state, repo, 3);
    const github = new FakeGitHub([baseIssue(3, [LABEL.ready])]);
    const sc = stepCtx(
      { state, git: new CloudGit(), gateRunner: new FakeGateRunner(), github } as unknown as StepCtx["deps"],
      config,
      baseIssue(3, [LABEL.ready]),
      worktreeDir(),
    );
    await cloudAware(STEP_TYPES.build!, testIo(fake)).run(sc);
    const bodies = github.issues
      .get(3)!
      .comments.map((c) => c.body)
      .join("\n")
      .toLowerCase();
    expect(bodies.includes("cursor")).toBe(false);
    expect(bodies.includes("cursor_api_key")).toBe(false);
    expect(bodies.includes("opusplan")).toBe(false);
    state.close();
  });

  test("restart reattaches", async () => {
    const fake = new FakeCloud();
    const git = new CloudGit();
    git.remoteSha = "bbb111";
    fake.onPoll = () => {
      git.remoteSha = "ccc222";
    };
    const state = new FactoryState(":memory:");
    state.setToggle("orchestrate", true);
    const repo = "acme/widgets";
    const config = mergeConfig({ repo, base: "main", orchestrate: { enabled: true } });
    const ledger = cloudLedger(state, repo);
    ledger.reserve(7, "cursor-cloud");
    ledger.started(7, "cursor-cloud", fake.runId, "aaa000");
    state.upsertRun({ repo, issue: 7, title: "t", stage: "build", status: "running", config_hash: "x" });
    const key = `${repo}#7#1`;
    const sc = stepCtx(
      {
        state,
        git,
        gateRunner: new FakeGateRunner(),
        github: new FakeGitHub([baseIssue(7, [LABEL.ready])]),
      } as unknown as StepCtx["deps"],
      config,
      baseIssue(7, [LABEL.ready]),
      worktreeDir(),
    );
    const out = await cloudAware(STEP_TYPES.build!, testIo(fake)).run(sc);
    expect(out.kind).toBe("next");
    expect(fake.lastKey).toBe(key);
    expect(agentIdFor(key)).toBe(agentIdFor(fake.lastKey));
    state.close();
  });
});

describe("cloud build step line count", () => {
  test("steps.ts stays under the baseline cap", () => {
    const lines = readFileSync(join(import.meta.dir, "../src/engine/steps.ts"), "utf8").split("\n").length;
    expect(lines).toBeLessThan(564);
  });
});
