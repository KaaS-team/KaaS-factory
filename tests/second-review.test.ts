// High risk runs a second verify session on a third model, and its red verdict blocks the merge.
import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import { runDir } from "../src/artifacts";
import type { FactoryConfig } from "../src/config";
import { secondReview } from "../src/engine/verify-facts";
import { factRefusals, type PrFacts } from "../src/pr-facts";
import { readVerifyFacts, writeVerifyFacts } from "../src/pr-facts-collect";

const agents = {
  a: {
    command: ["bash", "-c", 'printf "%s" "$0" > "$OUT"', "{{model}}"],
    model: "opus",
    models: { deep: "sonnet", wide: "gpt" },
  },
};
const stages = { triage: "a", plan: "a", build: "a", verify: "a", pr: "a" };

test("a high-risk task runs two review sessions on two different models, and a red second verdict stops the merge", async () => {
  const ex = new CommandExecutor(agents as never, stages as never);
  const seen: string[] = [];
  for (const reviewer of [0, 1]) {
    const out = join(mkdtempSync(join(tmpdir(), "second-review-out-")), "model");
    process.env.OUT = out;
    try {
      await ex.runStage({ stage: "verify", prompt: "", cwd: tmpdir(), reviewer } as never).catch(() => undefined);
      seen.push(readFileSync(out, "utf8"));
    } finally {
      delete process.env.OUT;
    }
  }
  expect(seen).toEqual(["sonnet", "gpt"]);

  const worktree = mkdtempSync(join(tmpdir(), "second-review-"));
  const dir = join(worktree, runDir(7));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ risk: "high" }));
  writeFileSync(join(dir, "verdict.json"), JSON.stringify({ result: "pass", findings: [] }));
  await writeVerifyFacts(worktree, 7, {
    cleanRoom: { ran: true, failToPass: true, passToPass: true },
    changedLines: { mutants: 1, survived: [] },
    tamper: [],
    supplyChain: { highFindings: 0, newDependencies: [], alerts: 0 },
    review: { builderModel: "opus", reviewers: [{ model: "sonnet", blockers: 0, verdict: "pass" }] },
  });
  const config = { agents, stages, routes: {} } as unknown as FactoryConfig;
  const sessions: number[] = [];
  const red = async (_d: unknown, _c: unknown, _i: unknown, stage: string, _w: string, opts: { reviewer?: number }) => {
    expect(stage).toBe("verify");
    sessions.push(opts.reviewer ?? 0);
    writeFileSync(join(dir, "verdict.json"), JSON.stringify({ result: "reject", findings: [] }));
    return { exitCode: 0, model: "gpt" };
  };
  await secondReview({} as never, config, { number: 7, labels: [] } as never, worktree, undefined, red as never);
  expect(sessions).toEqual([1]);
  // The first reviewer's verdict stays the one the run reads.
  expect(JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")).result).toBe("pass");

  const facts = await readVerifyFacts(worktree, 7);
  expect(facts?.review?.reviewers).toEqual([
    { model: "sonnet", blockers: 0, verdict: "pass" },
    { model: "gpt", blockers: 0, verdict: "reject" },
  ]);
  const full = {
    ...facts,
    risk: { level: "high", blastRadius: { owners: [], protected: [] } },
    ui: { changed: false, preview: false, smoke: false, unreviewedDiffs: 0 },
    postMergeWatch: true,
  } as unknown as PrFacts;
  const sevens = factRefusals(full, "full")
    .filter((r) => r.detail.startsWith("7:"))
    .map((r) => r.detail);
  expect(sevens).toEqual(["7: 1 review sessions did not pass"]);
});

test("a link the second session plants in the run directory never redirects the restore", async () => {
  const worktree = mkdtempSync(join(tmpdir(), "second-review-link-"));
  const dir = join(worktree, runDir(8));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ risk: "high" }));
  writeFileSync(join(dir, "verdict.json"), JSON.stringify({ result: "pass", findings: [] }));
  await writeVerifyFacts(worktree, 8, {
    cleanRoom: { ran: true, failToPass: true, passToPass: true },
    changedLines: { mutants: 1, survived: [] },
    tamper: [],
    supplyChain: { highFindings: 0, newDependencies: [], alerts: 0 },
    review: { builderModel: "opus", reviewers: [{ model: "sonnet", blockers: 0, verdict: "pass" }] },
  });
  const outside = join(mkdtempSync(join(tmpdir(), "second-review-outside-")), "target");
  writeFileSync(outside, "untouched");
  const plant = async () => {
    rmSync(join(dir, "verdict.json"));
    symlinkSync(outside, join(dir, "verdict.json"));
    return { exitCode: 0, model: "gpt" };
  };
  const config = { agents, stages, routes: {} } as unknown as FactoryConfig;
  await secondReview({} as never, config, { number: 8, labels: [] } as never, worktree, undefined, plant as never);
  expect(readFileSync(outside, "utf8")).toBe("untouched");
  expect(lstatSync(join(dir, "verdict.json")).isSymbolicLink()).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")).result).toBe("pass");
});
