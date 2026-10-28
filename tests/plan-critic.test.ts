// #89: the plan check runs before a plan posts. An AC with no test, or a command build cannot run,
// sends the plan back once on a fork of its session; what is still wrong waits for a human.

import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import { planFromIssue, type PlannedIssue } from "../src/engine/import-plan";
import { parseWorkflowText } from "../src/engine/workflows";
import {
  critiquePlan,
  deterministicCritique,
  estimateCost,
  planMustFix,
  proofAllowRules,
} from "../src/engine/plan-critic";
import { LABEL } from "../src/labels";
import { engine, removeEngineDirs } from "./engine-harness";

const SCRATCH = mkdtempSync(join(tmpdir(), "plan-critic-"));
mkdirSync(join(SCRATCH, "src"), { recursive: true });
writeFileSync(join(SCRATCH, "src", "exists.ts"), "export {};\n");

afterAll(() => {
  removeEngineDirs();
  rmSync(SCRATCH, { recursive: true, force: true });
});

// kaas.team's and englishmaa's agentCommands on 26 Oct 2026: node, npx and python3 are refused.
const AGENT_COMMANDS = {
  read: ["node *", "npm ls *", "git ls-tree *", "python3 scripts/lwp/*"],
  build: ["npm *", "npx *", "make *", "node *", "python3 scripts/lwp/*"],
  verify: ["npm *", "npx *", "make *", "node *", "python3 scripts/lwp/*"],
};
const ALLOW = proofAllowRules(mergeConfig({ repo: "acme/widgets", agentCommands: AGENT_COMMANDS }), 1);

const plan = (acs: string[], tests = "- `test/readme.test.mjs`") =>
  [
    "<!-- factory:plan v1 rev=1 -->",
    "## Plan (rev 1)",
    "### Acceptance criteria",
    ...acs,
    "### Tests to write first",
    tests,
    "### Risk: low",
  ].join("\n");

describe("planMustFix", () => {
  test("a plan whose ACs name tests and allowed commands passes", () => {
    const ok = plan([
      "- **AC-1:** README exists: checked by `test/readme.test.mjs`",
      "- **AC-2:** gate passes: checked by `.factory/gates.sh` and `make check`",
      "- **AC-3:** no ignore: checked by `git diff origin/main -- web | grep -c biome-ignore` printing `0`",
      '- **AC-4:** lockfile agrees: checked by `npm test -- --grep "a;b|c"`',
    ]);
    expect(planMustFix(ok, {}, ALLOW)).toEqual([]);
  });

  test("an AC with no test or command after checked by is must-fix (kaas.team#5 AC-3)", () => {
    const bad = plan(["- **AC-3:** no major changes: checked by comparing the majors by hand"]);
    expect(planMustFix(bad, {}, ALLOW)).toEqual([
      'AC-3 names no test or command: end it with "checked by `<test or command>`".',
    ]);
  });

  test("a command build may not run is must-fix: node, python3, a leading cd (kaas.team#5, englishmaa#4)", () => {
    const bad = plan([
      "- **AC-1:** floors hold: checked by `node --test test/advisory-floors.test.mjs`",
      "- **AC-2:** deps agree: checked by `cd web && node_modules/.bin/vitest run src/deps.test.ts`",
      "- **AC-3:** gate: checked by `python3 scripts/lwp/check-affected.py --run --base origin/main`",
    ]);
    expect(planMustFix(bad, {}, ALLOW)).toEqual([
      "AC-1: `node --test test/advisory-floors.test.mjs` is not a command build or verify may run, so it is refused there.",
      "AC-2: `cd web` is not a command build or verify may run, so it is refused there.",
      "AC-2: `node_modules/.bin/vitest run src/deps.test.ts` is not a command build or verify may run, so it is refused there.",
      "AC-3: `python3 scripts/lwp/check-affected.py --run --base origin/main` is not a command build or verify may run, so it is refused there.",
    ]);
  });

  test("a test-proof plan with no named test first, or an empty AC list, is must-fix", () => {
    expect(planMustFix(plan(["- **AC-1:** x: checked by `make test`"], "none"), {}, ALLOW)).toEqual([
      "Tests to write first names no test: name each one in backticks.",
    ]);
    expect(planMustFix(plan(["- **AC-1:** x: checked by `make test`"], "none"), { proof: "check" }, ALLOW)).toEqual([]);
    expect(planMustFix(plan([]), {}, ALLOW)).toEqual([
      "The plan lists no `- **AC-n:**` line under Acceptance criteria.",
    ]);
  });
});

describe("the plan step sends a must-fix plan back once", () => {
  const workflow = (() => {
    const text = readFileSync(join(import.meta.dir, "..", "template", ".factory", "workflows", "feature-to-pr.yml"));
    const r = parseWorkflowText(text.toString());
    if (!r.ok) throw new Error(r.problems.join("; "));
    return r.workflow;
  })();
  const json = JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true });
  const BAD = { "plan-comment.md": plan(["- **AC-1:** x: checked by `node --test t.mjs`"]), "plan.json": json };
  const GOOD = { "plan-comment.md": plan(["- **AC-1:** x: checked by `npm test`"]), "plan.json": json };
  const config = { agentCommands: AGENT_COMMANDS, toggles: { autoApproveLowRisk: true } };

  test("a revision that fixes it posts the fixed plan and auto-approves", async () => {
    const e = engine(workflow, 0, {}, {}, {}, { outputs: { plan: [BAD, GOOD] }, config });
    expect(await e.run()).toBe("shipped");
    const plans = e.executor.pinned.filter(([s]) => s === "plan");
    expect(plans).toHaveLength(2);
    const resume = e.executor.resumed.find((r) => r?.failure.includes("plan check"));
    expect(resume?.failure).toContain("`node --test t.mjs` is not a command build or verify may run");
    const posted = e.github.issues.get(1)!.comments.map((c) => c.body);
    expect(posted.some((b) => b.includes("checked by `npm test`"))).toBe(true);
    expect(posted.some((b) => b.includes("node --test"))).toBe(false);
  });

  test("a revision that is still wrong posts with the open items and waits for a human", async () => {
    const e = engine(workflow, 0, {}, {}, {}, { outputs: { plan: [BAD, BAD] }, config });
    await e.run();
    expect(e.executor.pinned.filter(([s]) => s === "plan")).toHaveLength(2);
    expect(e.github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.awaitingApproval]);
    const posted = e.github.issues.get(1)!.comments.map((c) => c.body);
    expect(posted.some((b) => b.includes("### Plan check: still open"))).toBe(true);
  });

  test("a deterministic failure sends the plan back once: a listed file outside the repo", async () => {
    const OUTSIDE = {
      "plan-comment.md": plan(["- **AC-1:** x: checked by `npm test`"]),
      "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["../escape.ts"], autoApproveEligible: true }),
    };
    const e = engine(workflow, 0, {}, {}, {}, { outputs: { plan: [OUTSIDE, GOOD] }, config });
    expect(await e.run()).toBe("shipped");
    expect(e.executor.pinned.filter(([s]) => s === "plan")).toHaveLength(2);
    const resume = e.executor.resumed.find((r) => r?.failure.includes("plan check"));
    expect(resume?.failure).toContain("`../escape.ts` is outside the repo.");
  });
});

// The model-free checks, one fixture per check. Each failing fixture is a plan that would otherwise reach the critic.
describe("deterministicCritique and critiquePlan", () => {
  const TASK_PLAN = {
    risk: "low",
    revision: 1,
    files: ["src/exists.ts"],
    autoApproveEligible: false,
    source: "issue",
    model: "sonnet",
    tasks: [{ id: "T1", model: "sonnet" }],
    criteria: [{ id: "AC-1", text: "x", task: "T1" }],
  };
  const COMMENT = "### Files to touch\n- `src/exists.ts`\n";
  const base = mergeConfig({ repo: "acme/widgets", agentCommands: AGENT_COMMANDS });
  const priced = mergeConfig({
    repo: "acme/widgets",
    agents: { sonnet: { command: ["claude"], model: "claude-sonnet-4-5" } },
    maxBudgetUsd: { triage: 1, plan: 2, build: 0.5, verify: 3, pr: 1, retro: 0.5 },
  });
  const check = (plan: object, comment = COMMENT, config = base) => ({ plan, comment, worktree: SCRATCH, config });

  test("a valid plan has no problem", () => {
    expect(deterministicCritique(check(TASK_PLAN))).toEqual([]);
  });

  test("deterministic: schema failure is reported", () => {
    const problems = deterministicCritique(check({ ...TASK_PLAN, risk: "extreme" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("fails its schema");
    expect(problems[0]).toContain('"risk"');
    expect(deterministicCritique(check({ ...TASK_PLAN, revision: undefined }))[0]).toContain('"revision" is required');
  });

  test("deterministic: a listed file that is outside the repo, missing and unmarked, or marked (new) but present is reported", () => {
    const files = (list: string[]) => ({ ...TASK_PLAN, files: list });
    const issue = (lines: string) => `### Files to touch\n${lines}\n`;
    expect(deterministicCritique(check(files(["../escape.ts"]), issue("- `../escape.ts`")))).toEqual([
      "`../escape.ts` is outside the repo.",
    ]);
    expect(deterministicCritique(check(files(["src/missing.ts"]), issue("- `src/missing.ts`")))).toEqual([
      "`src/missing.ts` does not exist; mark it (new) or fix the path.",
    ]);
    expect(deterministicCritique(check(files(["src/missing.ts"]), issue("- `src/missing.ts` (new)")))).toEqual([]);
    expect(deterministicCritique(check(files(["src/exists.ts"]), issue("- `src/exists.ts` (new)")))).toEqual([
      "`src/exists.ts` is marked (new) but already exists.",
    ]);
  });

  test("a planner plan's missing unmarked file is not checked on disk, only the outside-the-repo rule applies", () => {
    const planner = { ...TASK_PLAN, source: "planner", files: ["src/missing.ts"] };
    expect(deterministicCritique(check(planner, "### Files to touch\n- `src/missing.ts`\n"))).toEqual([]);
  });

  test("a plan with no source that marks any file (new) gets the disk rules too", () => {
    const plan = { ...TASK_PLAN, source: undefined, files: ["src/missing.ts", "src/exists.ts", "src/other.ts"] };
    const comment = "### Files to touch\n- `src/missing.ts`\n- `src/exists.ts`\n- `src/other.ts` (new)\n";
    expect(deterministicCritique(check(plan, comment))).toEqual([
      "`src/missing.ts` does not exist; mark it (new) or fix the path.",
    ]);
  });

  test("deterministic: a criterion with no task, or an unknown task, is reported when the plan has tasks", () => {
    const plan = {
      ...TASK_PLAN,
      criteria: [
        { id: "AC-1", text: "x", task: "T1" },
        { id: "AC-2", text: "y" },
        { id: "AC-3", text: "z", task: "T9" },
      ],
    };
    expect(deterministicCritique(check(plan))).toEqual([
      "AC-2 maps to no task, which is not a task in Change.",
      "AC-3 maps to T9, which is not a task in Change.",
    ]);
    const planner = { ...TASK_PLAN, tasks: undefined, criteria: [{ id: "AC-1", text: "x" }] };
    expect(deterministicCritique(check(planner))).toEqual([]);
  });

  test("estimateCost prices one run per task with costFor, and makes no estimate for an unpriced model", () => {
    // 150k in at $3/M plus 15k out at $15/M: $0.675 for one sonnet run.
    expect(estimateCost(TASK_PLAN, priced)).toBeCloseTo(0.675, 6);
    expect(estimateCost(TASK_PLAN, base)).toBeUndefined();
    expect(deterministicCritique(check(TASK_PLAN, COMMENT, base))).toEqual([]);
  });

  test("deterministic: an estimate over maxBudgetUsd.build is reported, naming both numbers", () => {
    const problems = deterministicCritique(check(TASK_PLAN, COMMENT, priced));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("$0.50 maxBudgetUsd.build");
    expect(problems[0]).toMatch(/\$0\.6[78]/);
  });

  test("critiquePlan never calls the model critic when a deterministic check fails, and calls it once on a clean plan", () => {
    const failing = [
      check({ ...TASK_PLAN, risk: "extreme" }),
      check({ ...TASK_PLAN, files: ["src/missing.ts"] }),
      check({ ...TASK_PLAN, criteria: [{ id: "AC-1", text: "x" }] }),
      check(TASK_PLAN, COMMENT, priced),
    ];
    for (const input of failing) {
      const critic = mock((_: unknown) => [] as string[]);
      expect(critiquePlan(input, critic).length).toBeGreaterThan(0);
      expect(critic).toHaveBeenCalledTimes(0);
    }
    const critic = mock((_: unknown) => [] as string[]);
    expect(critiquePlan(check(TASK_PLAN), critic)).toEqual([]);
    expect(critic).toHaveBeenCalledTimes(1);
  });
});

// Without `task` in plan.json the AC-to-task check never sees a real plan's tasks.
test("planFromIssue keeps task on each plan.json criterion, and the check accepts the result", () => {
  const planned: PlannedIssue = {
    goal: "g",
    tasks: [{ id: "T1", title: "t", files: ["src/exists.ts"], model: "sonnet", steps: ["do it"], deps: [] }],
    tests: ["t.test.ts"],
    mutations: [],
    criteria: [{ id: "AC-1", text: "x", commands: ["make check"], task: "T1" }],
    nonGoals: [],
    files: [{ path: "src/exists.ts", isNew: false }],
    risk: "low",
    model: "sonnet",
    meta: { deps: [], runner: "factory", declared: false, problems: [] },
  };
  const { plan, comment } = planFromIssue(planned, { body: "b" });
  expect(plan.criteria).toEqual([{ id: "AC-1", text: "x", task: "T1" }]);
  const config = mergeConfig({ repo: "acme/widgets" });
  expect(deterministicCritique({ plan, comment, worktree: SCRATCH, config })).toEqual([]);
});

// The judgment half: the plan skill dispatches one Sonnet critic with a fixed checklist, and it reads only.
test("factory-plan dispatches factory-plan-critic once, a read-only Sonnet agent", () => {
  const root = join(import.meta.dir, "..", "template", ".claude");
  const skill = readFileSync(join(root, "skills", "factory-plan", "SKILL.md"), "utf8").replace(/\s+/g, " ");
  expect(skill).toContain("dispatch `factory-plan-critic` once");
  expect(skill).toContain("never dispatch it again");
  const agent = readFileSync(join(root, "agents", "factory-plan-critic.md"), "utf8");
  expect(agent).toMatch(/^tools: Read, Grep, Glob$/m);
  expect(agent).toMatch(/^model: sonnet$/m);
  for (const item of ["traces to the issue", "release-age cooldown", "Changes a repo gate needs"])
    expect(agent).toContain(item);
});
