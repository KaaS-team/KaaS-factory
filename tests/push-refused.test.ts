import { afterAll, describe, expect, test } from "bun:test";
import { defaultWorkflow } from "../src/engine/workflows";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const PLAN = {
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
  "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true }),
};
const make = () => engine(defaultWorkflow(), 0, {}, {}, {}, { outputs: { plan: [PLAN] } });
type Engine = ReturnType<typeof make>;
const comments = (e: Engine) =>
  e.github.issues
    .get(1)!
    .comments.map((c) => c.body)
    .join("\n");
const verifyRuns = (e: Engine) => e.executor.mcp.filter(([stage]) => stage === "verify");

describe("a refused push", () => {
  test("a refused push fails the build with the stderr tail", async () => {
    const e = make();
    e.git.pushCode = 1;
    e.git.pushStderr = "lease stale";
    expect(await e.run()).toBe("failed");
    expect(verifyRuns(e)).toHaveLength(0);
    expect(comments(e)).toContain("push_refused");
    expect(comments(e)).toContain("lease stale");
  });

  test("a multi-line refusal keeps its decisive last line", async () => {
    const e = make();
    e.git.pushCode = 1;
    e.git.pushStderr = "remote: noise\nremote: more noise\n ! [remote rejected] HEAD -> branch (hook declined)";
    expect(await e.run()).toBe("failed");
    expect(comments(e)).toContain("hook declined");
  });

  test("a clean push still reaches verify", async () => {
    const e = make();
    expect(await e.run()).toBe("shipped");
    expect(verifyRuns(e)).toHaveLength(1);
  });

  test("pr does not open when the remote head differs", async () => {
    const e = make();
    e.git.remoteHead = "def";
    expect(await e.run()).toBe("failed");
    expect(e.github.createdPrs).toHaveLength(0);
    expect(comments(e)).toContain("pr_head_mismatch");
    expect(e.executor.mcp.filter(([stage]) => stage === "pr")).toHaveLength(0);
  });

  test("pr does not open when the remote cannot be read", async () => {
    const e = make();
    e.git.remoteHeadError = "git ls-remote failed: network down";
    expect(await e.run()).toBe("failed");
    expect(e.github.createdPrs).toHaveLength(0);
    expect(comments(e)).toContain("pr_remote_unreachable");
  });

  test("pr does not open for an empty branch", async () => {
    const e = make();
    e.git.commits = false;
    expect(await e.run()).toBe("failed");
    expect(e.github.createdPrs).toHaveLength(0);
    expect(comments(e)).toContain("pr_empty");
  });
});
