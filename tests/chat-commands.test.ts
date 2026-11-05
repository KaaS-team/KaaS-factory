// Chat commands apply once. A revise on a needs-human issue resumes at build with its text, a retry
// resumes where the run failed, neither replays after the run parks again, and a cancel older than
// a reopen is ignored.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import type { StageName } from "../src/executor";
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

// Records the revise.md each build was handed, since the workspace is dropped once a run ships.
class SpyExecutor extends MultiStageExecutor {
  readonly reviseSeen: Array<string | undefined> = [];
  override async runStage(opts: Parameters<MultiStageExecutor["runStage"]>[0]) {
    if (opts.stage === "build") {
      const file = join(opts.cwd, ".factory/runs/issue-1/revise.md");
      this.reviseSeen.push(existsSync(file) ? readFileSync(file, "utf8") : undefined);
    }
    return super.runStage(opts);
  }
}

// A run whose build went green and whose verify came back uncertain, so it waits on a person.
async function parkedAtVerify() {
  mkdirSync(tmpdir(), { recursive: true });
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const github = new FakeGitHub([baseIssue(1, [LABEL.ready])]);
  const state = new FactoryState(":memory:");
  const executor = new SpyExecutor();
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
  const step = () => advanceIssue(deps, config, github.issues.get(1)!);
  const push = (stage: StageName, files: Record<string, string>) =>
    executor.push(stage, 1, fixtureFor(stage, 1), files);
  const build = () =>
    push("build", {
      "status-comment.md": "<!-- factory:status v1 -->\nbuilding",
      "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
    });
  const verify = (result: "pass" | "uncertain") =>
    push("verify", {
      "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
      "verdict.json": JSON.stringify({ result, rounds: 1, findings: [] }),
    });
  const ship = () => push("pr", { "pr-body.md": "Did it.\nCloses #1" });
  state.setToggle("auto_approve_low_risk", true);
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
    "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }),
  });
  build();
  verify("uncertain");
  expect(await step()).toBe("needs-human");
  expect(github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.needsHuman]);
  return { github, state, executor, step, build, verify, ship };
}

describe("/factory revise on a needs-human issue", () => {
  test("resumes at build, not at the verify that parked it, with the text as revise.md", async () => {
    const { github, executor, step, build, verify, ship, state } = await parkedAtVerify();
    build();
    verify("pass");
    ship();
    github.say(1, "/factory revise use a map, not a list");
    expect(await step()).toBe("shipped");
    expect(executor.reviseSeen).toEqual([undefined, "use a map, not a list"]);
    state.close();
  });

  test("a retry still resumes at the stage that last failed, without a rebuild", async () => {
    const { github, executor, step, verify, ship, state } = await parkedAtVerify();
    verify("pass");
    ship();
    github.say(1, "/factory retry");
    expect(await step()).toBe("shipped");
    expect(github.issues.get(1)!.comments.some((c) => c.body.includes("Retrying from verify."))).toBe(true);
    expect(executor.reviseSeen).toHaveLength(1);
    state.close();
  });

  test("a revise is applied once: a run that parks again with no new comment does not replay it", async () => {
    const { github, executor, step, build, verify, state } = await parkedAtVerify();
    build();
    verify("uncertain");
    github.say(1, "/factory revise use a map");
    expect(await step()).toBe("needs-human");
    expect(executor.reviseSeen).toHaveLength(2);
    build();
    verify("uncertain");
    expect(await step()).toBe("waiting");
    expect(executor.reviseSeen).toHaveLength(2);
    state.close();
  });
});

describe("/factory cancel is applied once", () => {
  // After a cancel, a maintainer reopens the issue and puts a waiting label back by hand. The fake's
  // `closed` lists each close, so a replayed cancel shows as a second entry.
  const reopenedAs = async (label: string, before?: string) => {
    const run = await parkedAtVerify();
    if (before) await run.github.commentIssue("acme/widgets", 1, before);
    run.github.say(1, "/factory cancel");
    expect(await run.step()).toBe("cancelled");
    expect(run.github.closed).toEqual([1]);
    run.github.issues.get(1)!.labels = [{ name: label }];
    return run;
  };

  test.each([
    ["needs-human", LABEL.needsHuman, undefined],
    ["failed", LABEL.failed, undefined],
    ["awaiting approval", LABEL.awaitingApproval, undefined],
    ["needs-info", LABEL.needsInfo, "<!-- factory:question v1 -->\nWhich file?"],
  ])("a cancel older than the reopen is ignored on a %s issue", async (_name, label, before) => {
    const { github, step, state } = await reopenedAs(label, before);
    expect(await step()).toBe("waiting");
    expect(github.closed).toEqual([1]);
    state.close();
  });

  test("a cancel older than the reopen is ignored on an issue held for an overlap", async () => {
    const { github, step, build, verify, ship, state } = await reopenedAs(LABEL.overlap);
    build();
    verify("pass");
    ship();
    expect(await step()).toBe("shipped");
    expect(github.closed).toEqual([1]);
    state.close();
  });

  test("a cancel newer than the reopen still cancels", async () => {
    const { github, step, state } = await reopenedAs(LABEL.needsHuman);
    github.say(1, "/factory cancel");
    expect(await step()).toBe("cancelled");
    expect(github.closed).toEqual([1, 1]);
    state.close();
  });
});
