import { describe, expect, test } from "bun:test";
import { mergeConfig } from "../src/config";
import { postComment } from "../src/engine/common";
import { Git } from "../src/git";
import type { CommandRunner } from "../src/github";
import { FactoryState } from "../src/state";
import type { WatchDeps } from "../src/watch";
import { baseIssue, FakeGitHub } from "./harness";

const key = "gh" + "p_" + "abcdefghijklmnopqrstuvwx";

function commentSetup() {
  const github = new FakeGitHub([baseIssue(1, [])]);
  const state = new FactoryState(":memory:");
  const config = mergeConfig({ repo: "acme/widgets" });
  state.upsertRun({ issue: 1, repo: config.repo, title: "t", stage: "build", status: "running" });
  return { github, state, config, deps: { github, state } as unknown as WatchDeps };
}

describe("comment gate", () => {
  test("a body with a key is never posted and the run needs a human", async () => {
    const { github, state, config, deps } = commentSetup();
    await postComment(deps, config, 1, `here: ${key}`);
    expect(github.issues.get(1)!.comments).toHaveLength(0);
    const run = state.getRun(config.repo, 1)!;
    expect(run.status).toBe("needs-human");
    expect(run.reason).toContain("github-token at line 1");
    expect(run.reason).not.toContain(key);
  });

  test("a clean body is posted", async () => {
    const { github, config, deps } = commentSetup();
    await postComment(deps, config, 1, "all good");
    expect(github.issues.get(1)!.comments).toHaveLength(1);
  });
});

function runnerWith(diff: string) {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(args) {
      calls.push(args);
      return { stdout: args[0] === "log" ? diff : "", stderr: "", code: 0 };
    },
  };
  return { calls, git: new Git(runner) };
}

describe("push gate", () => {
  test("a diff with a key blocks the push", async () => {
    const { calls, git } = runnerWith(`+token = ${key}\n`);
    const res = await git.pushBranch("/w", "b");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("github-token at line 1");
    expect(res.stderr).not.toContain(key);
    expect(calls.some((c) => c[0] === "push")).toBe(false);
  });

  test("a clean diff is pushed", async () => {
    const { calls, git } = runnerWith("+const a = 1;\n");
    const res = await git.pushBranch("/w", "b");
    expect(res.code).toBe(0);
    expect(calls.some((c) => c[0] === "push")).toBe(true);
  });
});
