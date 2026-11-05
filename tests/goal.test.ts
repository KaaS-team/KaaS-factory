// The build prompt opens with a goal checklist and checkpoints; verify refuses an incomplete report; plan refuses an
// issue with no acceptance lines (#636).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import { buildContextPack } from "../src/context";
import { incompleteReport } from "../src/engine/build-report";
import { defaultWorkflow } from "../src/engine/workflows";
import { engine, removeEngineDirs } from "./engine-harness";
import { acceptanceLines, CHECKPOINTS, goalSection, NO_ACCEPTANCE_LINE, reportProblems } from "../src/goal";

afterAll(removeEngineDirs);

const answers = CHECKPOINTS.map((_, i) => ({ id: i + 1, answer: "yes" }));
const done = { goal: [{ id: "AC-1", test: "t", checked: true }], checkpoints: answers };

test("acceptance lines come from an Acceptance section or AC-n lines, and an empty body has none", () => {
  const body =
    "## Why\n- not this\n\n## Acceptance\n- first\n- [ ] second\n\n## Out of scope\n- nor this\n- AC-9: counted anywhere";
  expect(acceptanceLines(body)).toEqual(["first", "second", "AC-9: counted anywhere"]);
  expect(acceptanceLines("do the thing")).toEqual([]);
});

test("the goal section has one row per acceptance line, each naming its test, then the six checkpoints", () => {
  const text = goalSection([
    { id: "AC-1", text: "one" },
    { id: "AC-2", text: "two" },
  ]);
  expect(text.split("\n").filter((l) => l.startsWith("- [ ] "))).toEqual([
    "- [ ] AC-1: one -> test: <name>",
    "- [ ] AC-2: two -> test: <name>",
  ]);
  for (const [i, c] of CHECKPOINTS.entries()) expect(text).toContain(`${i + 1}. ${c}`);
  expect(CHECKPOINTS.join(" ")).toMatch(/files.*plan|plan.*files/i);
});

test("the build pack opens with the goal and checkpoints, and no other stage's pack has them", async () => {
  mkdirSync(tmpdir(), { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), "goal-pack-"));
  mkdirSync(join(cwd, runDir(7)), { recursive: true });
  writeFileSync(
    join(cwd, runDir(7), "plan.json"),
    JSON.stringify({
      risk: "low",
      revision: 1,
      files: [],
      autoApproveEligible: true,
      criteria: [{ id: "AC-1", text: "x" }],
    }),
  );
  expect(await buildContextPack("build", 7, cwd)).toStartWith("## Context pack\n\n### goal and checkpoints\n\nGoal:");
  expect(await buildContextPack("verify", 7, cwd)).not.toContain("goal and checkpoints");
});

test("a complete build report has no problems", () => {
  expect(reportProblems(done, ["AC-1"])).toEqual([]);
});

test("a goal row left unchecked, without a test, or missing is a problem", () => {
  expect(reportProblems({ ...done, goal: [{ id: "AC-1", test: "t", checked: false }] }, ["AC-1"])).toEqual([
    "goal row AC-1 is unchecked",
  ]);
  expect(reportProblems({ ...done, goal: [{ id: "AC-1", test: " ", checked: true }] }, ["AC-1"])).toEqual([
    "goal row AC-1 names no test",
  ]);
  expect(reportProblems(done, ["AC-1", "AC-2"])).toEqual(["goal row AC-2 is missing"]);
  expect(reportProblems({ checkpoints: answers }, [])).toEqual(["build.json has no goal rows"]);
});

test("a checkpoint left unanswered, or answered no, is a problem", () => {
  const without = reportProblems({ ...done, checkpoints: answers.slice(1) }, ["AC-1"]);
  expect(without).toEqual(["checkpoint 1 is unanswered (Plan)"]);
  const no = [{ id: 1, answer: "no: touched src/x.ts" }, ...answers.slice(1)];
  expect(reportProblems({ ...done, checkpoints: no }, ["AC-1"])).toEqual([
    "checkpoint 1 is a deviation: no: touched src/x.ts",
  ]);
  expect(reportProblems({ goal: done.goal }, ["AC-1"]).length).toBe(CHECKPOINTS.length);
});

function worktree(files: Record<string, unknown>): string {
  mkdirSync(tmpdir(), { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), "goal-run-"));
  mkdirSync(join(cwd, runDir(7)), { recursive: true });
  for (const [name, json] of Object.entries(files)) writeFileSync(join(cwd, runDir(7), name), JSON.stringify(json));
  return cwd;
}
const plan = { risk: "low", revision: 1, files: [], autoApproveEligible: true, criteria: [{ id: "AC-1", text: "x" }] };

test("verify's rule: a report that skips the goal is sent back, a complete one or a goal-less plan is not", () => {
  const skipped = incompleteReport(
    worktree({ "plan.json": plan, "build.json": { status: "green", gate_line: "ok", rounds: 1 } }),
    7,
  );
  expect(skipped?.body).toContain("- build.json has no goal rows");
  expect(skipped?.body).toContain("- checkpoint 1 is unanswered (Plan)");
  const complete = worktree({
    "plan.json": plan,
    "build.json": { status: "green", gate_line: "ok", rounds: 1, ...done },
  });
  expect(incompleteReport(complete, 7)?.why ?? "complete").toBe("complete");
  const noGoal = { ...plan, criteria: [] };
  const bare = worktree({ "plan.json": noGoal, "build.json": { status: "green", gate_line: "ok", rounds: 1 } });
  expect(incompleteReport(bare, 7)?.why ?? "no goal handed out").toBe("no goal handed out");
});

test("plan's rule: an issue with no acceptance line is refused at plan with one line, and the plan agent never runs", async () => {
  const e = engine(defaultWorkflow(), 0);
  e.github.issues.get(1)!.body = "do the thing";
  expect(await e.run()).toBe("needs-human");
  expect(e.executor.scopes.map(([stage]) => stage)).not.toContain("plan");
  const comments = e.github.issues.get(1)!.comments.map((c) => c.body);
  expect(comments.filter((b) => b.includes(NO_ACCEPTANCE_LINE))).toHaveLength(1);
  expect(NO_ACCEPTANCE_LINE.split("\n")).toHaveLength(1);
});

test("an issue with an acceptance line reaches plan", async () => {
  const e = engine(defaultWorkflow(), 0);
  await e.run().catch(() => undefined); // no plan output is queued, so the plan agent's start is the proof

  expect(e.executor.scopes.map(([stage]) => stage)).toContain("plan");
});

test("end to end: verify sends a build that skipped its goal back to build, then ships the complete one", async () => {
  const build = (report: object) => ({
    "status-comment.md": "<!-- factory:status v1 -->\nb",
    "build.json": JSON.stringify(report),
  });
  const verdict = {
    "verdict-comment.md": "<!-- factory:verdict v1 -->\nv",
    "verdict.json": JSON.stringify({
      result: "pass",
      rounds: 1,
      findings: [],
      criteria: [{ id: "AC-1", status: "pass" }],
    }),
  };
  const e = engine(
    defaultWorkflow(),
    0,
    {},
    {},
    {},
    {
      outputs: {
        plan: [
          {
            "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
            "plan.json": JSON.stringify(plan),
          },
        ],
        build: [
          build({ status: "green", gate_line: "ok", rounds: 1 }),
          build({ status: "green", gate_line: "ok", rounds: 1, ...done }),
        ],
        verify: [verdict, verdict],
      },
    },
  );
  e.github.issues.get(1)!.body = "x\n\n## Acceptance\n- AC-1: x";
  await e.run();
  expect(e.executor.scopes.map(([stage]) => stage).filter((st) => st === "build")).toHaveLength(2);
  const comments = e.github.issues
    .get(1)!
    .comments.map((c) => c.body)
    .join("\n");
  expect(comments).toContain("The build report is incomplete");
  expect(comments).toContain("- build.json has no goal rows");
});
