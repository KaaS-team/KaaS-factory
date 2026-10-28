import { afterAll, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
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

  test("a refused push shows the last 20 lines of stderr", async () => {
    const e = make();
    e.git.pushCode = 1;
    e.git.pushStderr = Array.from({ length: 25 }, (_, i) => `stderr-${String(i + 1).padStart(2, "0")}`).join("\n");
    expect(await e.run()).toBe("failed");
    expect(comments(e)).toContain("stderr-06");
    expect(comments(e)).toContain("stderr-25");
    expect(comments(e)).not.toContain("stderr-05");
  });

  test("a remote URL's credentials and the home path never reach the thread", async () => {
    const e = make();
    e.git.pushCode = 1;
    e.git.pushStderr = `fatal: unable to access 'https://x-access-token:s3cr3tvalue@github.com/o/r.git/' in ${homedir()}/w`;
    expect(await e.run()).toBe("failed");
    expect(comments(e)).toContain("push_refused");
    expect(comments(e)).not.toContain("s3cr3tvalue");
    expect(comments(e)).not.toContain(homedir());
  });

  test("empty stderr posts no empty fence", async () => {
    const e = make();
    e.git.pushCode = 1;
    e.git.pushStderr = "  \n";
    expect(await e.run()).toBe("failed");
    expect(comments(e)).not.toContain("````");
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
