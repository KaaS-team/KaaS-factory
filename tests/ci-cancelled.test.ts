// A cancelled ci run is restarted unless a newer push superseded it, and a cancelled check is never green (#567).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CiRun, decideRerun, MAX_ATTEMPTS, rerunIfCancelled } from "../src/ci-cancelled";
import { ciStatusNow } from "../src/ci";
import type { CommandRunner } from "../src/github";

const run = (over: Partial<CiRun> = {}): CiRun => ({
  conclusion: "cancelled",
  headSha: "h1",
  attempt: 1,
  pr: 7,
  ...over,
});

describe("decideRerun", () => {
  test("a cancelled run on the PR's current head reruns", () => {
    expect(decideRerun(run(), "h1")).toEqual({ rerun: true });
  });
  test("a run a newer push superseded is left alone", () => {
    expect(decideRerun(run(), "h2")).toEqual({ rerun: false, reason: "a newer push superseded the run" });
  });
  test("a run that is not cancelled is left alone", () => {
    for (const conclusion of ["success", "failure", null])
      expect(decideRerun(run({ conclusion }), "h1").rerun).toBe(false);
  });
  test("a run with no open PR is left alone", () => {
    expect(decideRerun(run({ pr: undefined }), undefined).rerun).toBe(false);
    expect(decideRerun(run(), undefined).rerun).toBe(false);
  });
  test("the attempt cap stops a loop", () => {
    expect(decideRerun(run({ attempt: MAX_ATTEMPTS - 1 }), "h1").rerun).toBe(true);
    expect(decideRerun(run({ attempt: MAX_ATTEMPTS }), "h1").rerun).toBe(false);
  });
});

function fake(opts: { conclusion: string; runSha: string; prSha: string; prState?: string; attempt?: number }) {
  const posts: string[] = [];
  const gh: CommandRunner = {
    run: async (args) => {
      const url = args.find((a) => a.startsWith("repos/")) ?? "";
      const ok = (v: unknown) => ({ stdout: JSON.stringify(v), stderr: "", code: 0 });
      if (args.includes("POST")) return posts.push(url), ok({});
      if (url.includes("/actions/runs/"))
        return ok({
          conclusion: opts.conclusion,
          head_sha: opts.runSha,
          run_attempt: opts.attempt ?? 1,
          pull_requests: [{ number: 7 }],
        });
      return ok({ state: opts.prState ?? "open", head: { sha: opts.prSha } });
    },
  };
  return { gh, posts };
}

describe("rerunIfCancelled", () => {
  test("posts a rerun for a cancelled run on the current head", async () => {
    const { gh, posts } = fake({ conclusion: "cancelled", runSha: "h1", prSha: "h1" });
    expect(await rerunIfCancelled(gh, "o/r", 99)).toEqual({ rerun: true });
    expect(posts).toEqual(["repos/o/r/actions/runs/99/rerun"]);
  });
  test("posts nothing when the PR head moved on", async () => {
    const { gh, posts } = fake({ conclusion: "cancelled", runSha: "h1", prSha: "h2" });
    expect((await rerunIfCancelled(gh, "o/r", 99)).rerun).toBe(false);
    expect(posts).toEqual([]);
  });
  test("posts nothing when the PR is closed", async () => {
    const { gh, posts } = fake({ conclusion: "cancelled", runSha: "h1", prSha: "h1", prState: "closed" });
    expect((await rerunIfCancelled(gh, "o/r", 99)).rerun).toBe(false);
    expect(posts).toEqual([]);
  });
});

describe("the merge step", () => {
  const statusOf = async (conclusion: string) =>
    (
      await ciStatusNow(
        {
          prStatus: async () => ({
            state: "open",
            headRefOid: "h1",
            closingIssuesReferences: [],
            statusCheckRollup: [{ name: "push", status: "COMPLETED", conclusion }],
          }),
        },
        "o/r",
        7,
      )
    ).status;
  test("never reads a cancelled check as green", async () => {
    expect(await statusOf("CANCELLED")).toBe("failed");
    expect(await statusOf("SUCCESS")).toBe("passed");
  });
});

describe("the staged workflow", () => {
  const wf = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", "ci", "rerun-cancelled.yml"), "utf8")) as {
    on: { workflow_run: { workflows: string[]; types: string[] } };
    jobs: { rerun: { if: string; steps: { run?: string }[] } };
  };
  test("runs when ci completes, only for a cancelled pull request run, and calls the script", () => {
    expect(wf.on.workflow_run).toEqual({ workflows: ["ci"], types: ["completed"] });
    expect(wf.jobs.rerun.if).toContain("conclusion == 'cancelled'");
    expect(wf.jobs.rerun.steps.some((s) => s.run?.includes("scripts/rerun-cancelled.ts"))).toBe(true);
  });
});
