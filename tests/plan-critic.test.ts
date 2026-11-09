// #89: the plan check runs before a plan posts. An AC with no test, or a command build cannot run,
// sends the plan back once on a fork of its session; what is still wrong waits for a human.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanArtifact } from "../src/artifacts";
import { mergeConfig } from "../src/config";
import type { StageRunOptions } from "../src/ports/agent";
import {
  deterministicCritique,
  estimateCost,
  PLAN_COST,
  planMustFix,
  proofAllowRules,
} from "../src/engine/plan-critic";
import { parseWorkflowText } from "../src/engine/workflows";
import { LABEL } from "../src/labels";
import { planCritiqueProblem } from "../src/schemas";
import { FactoryState } from "../src/state";
import { engine, removeEngineDirs } from "./engine-harness";

const scratch: string[] = [];
afterAll(() => {
  removeEngineDirs();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
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

describe("deterministicCritique", () => {
  const worktree = mkdtempSync(join(tmpdir(), "plan-critic-"));
  scratch.push(worktree);
  mkdirSync(join(worktree, "src"));
  writeFileSync(join(worktree, "src", "a.ts"), "");
  const config = mergeConfig({ repo: "acme/widgets", agentCommands: AGENT_COMMANDS });
  const comment = plan(["- **AC-1:** a: checked by `make test`", "- **AC-2:** b: checked by `make check`"]);
  const good = (): PlanArtifact => ({
    risk: "low",
    revision: 1,
    files: ["src/a.ts", "src/new.ts"],
    autoApproveEligible: false,
    criteria: [
      { id: "AC-1", text: "a" },
      { id: "AC-2", text: "b" },
    ],
  });
  const critique = (c: string, p: unknown, cfg = config) =>
    deterministicCritique(c, p as PlanArtifact, { config: cfg, issue: 1, worktree });

  test("estimateCost pins its constants", () => {
    expect(PLAN_COST).toEqual({ base: 0.5, perFile: 0.4, perCriterion: 0.2 });
    expect(estimateCost({ files: ["a", "b"], criteria: [{ id: "AC-1", text: "x" }] })).toBeCloseTo(1.5);
    expect(estimateCost({ files: [] })).toBe(0.5);
  });

  test("deterministicCritique flags schema, files, AC mapping and cost problems", () => {
    expect(critique(comment, good())).toEqual([]);
    expect(critique(comment, { ...good(), risk: "huge" })).toEqual(['plan.json: "risk" has the wrong type or value.']);
    expect(critique(comment, { ...good(), files: ["../etc/passwd", "nodir/x.ts"] })).toEqual([
      "`../etc/passwd` is outside the repo.",
      "`nodir/x.ts` does not exist and neither does its directory.",
    ]);
    const renamed = {
      ...good(),
      criteria: [
        { id: "AC-1", text: "a" },
        { id: "AC-3", text: "c" },
      ],
    };
    expect(critique(comment, renamed)).toEqual([
      "AC-3 is in plan.json but has no `- **AC-3:**` line in the comment.",
      "AC-2 is in the comment but not in plan.json criteria.",
    ]);
    const tasked = {
      ...good(),
      tasks: [{ id: "T-1" }],
      criteria: [
        { id: "AC-1", text: "a", task: "T-9" },
        { id: "AC-2", text: "b", task: "T-1" },
      ],
    };
    expect(critique(comment, tasked)).toEqual(["AC-1 names task T-9, which is not in plan.tasks."]);
    const tight = mergeConfig({
      repo: "acme/widgets",
      agentCommands: AGENT_COMMANDS,
      maxBudgetUsd: { triage: 1, plan: 2, build: 1, verify: 3, pr: 1, retro: 0.5 },
    });
    expect(critique(comment, good(), tight)).toEqual([
      "The estimate $1.70 is over the build budget $1.00: split the plan.",
    ]);
    expect(critique(plan(["- **AC-1:** a: checked by `node t.mjs`"]), { ...good(), criteria: undefined })).toEqual([
      "AC-1: `node t.mjs` is not a command build or verify may run, so it is refused there.",
    ]);
  });

  test("planCritiqueSchema takes only verdict and reasons", () => {
    expect(planCritiqueProblem({ verdict: "pass", reasons: [] })).toBeUndefined();
    expect(planCritiqueProblem({ verdict: "maybe", reasons: [] })).toBeDefined();
    expect(planCritiqueProblem({ verdict: "pass" })).toBeDefined();
    expect(planCritiqueProblem({ verdict: "pass", reasons: [], extra: 1 })).toBeDefined();
  });

  test("addPendingLesson writes a done row pendingLessons returns", () => {
    const state = new FactoryState(":memory:");
    state.addPendingLesson("acme/widgets", 3, "x");
    const rows = state.pendingLessons("acme/widgets").map((r) => [r.issue, r.outcome, r.lesson]);
    expect(rows).toEqual([[3, "plan-critic", "x"]]);
    state.close();
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
  const config = {
    agentCommands: AGENT_COMMANDS,
    toggles: { autoApproveLowRisk: true },
    agents: { claude: { preset: "claude" }, sonnet: { preset: "claude" } },
  };

  // The rubric goes to the executor directly, so it never reaches the queue the plan stage reads.
  function rubricEngine(
    plans: Array<Record<string, string>>,
    replies: string[],
    cfg: Record<string, unknown> = config,
  ) {
    const e = engine(workflow, 0, {}, {}, {}, { outputs: { plan: plans }, config: cfg });
    const calls: Array<{ agent?: string; prompt?: string; maxBudgetUsd: number }> = [];
    const inner = e.executor;
    e.deps.executor = {
      async runStage(opts: StageRunOptions) {
        if (opts.prompt === undefined) return inner.runStage(opts as never);
        calls.push(opts);
        return {
          events: [],
          toolCalls: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          exitCode: 0,
          permissionDenials: [],
          finalMessage: replies.shift(),
        };
      },
    };
    const planRuns = () => inner.pinned.filter(([s]) => s === "plan").length;
    const posted = () => e.github.issues.get(1)!.comments.map((c) => c.body);
    return { e, calls, planRuns, posted };
  }
  const PASS = JSON.stringify({ verdict: "pass", reasons: [] });
  const REVISE = JSON.stringify({ verdict: "revise", reasons: ["AC-1 drifts from the issue"] });

  test("a deterministic failure never calls the rubric model", async () => {
    const r = rubricEngine([BAD, BAD], []);
    await r.e.run();
    expect(r.calls).toHaveLength(0);
    expect(r.planRuns()).toBe(2);
  });

  test("rubric runs once after a clean deterministic pass and validates its reply", async () => {
    const pass = rubricEngine([GOOD], [PASS]);
    expect(await pass.e.run()).toBe("shipped");
    expect(pass.calls).toHaveLength(1);
    expect(pass.calls[0]!.agent).toBe("sonnet");
    expect(pass.calls[0]!.maxBudgetUsd).toBe(mergeConfig({}).maxBudgetUsd.plan);
    for (const item of ["intent", "scope creep", "verify per task", "risk set", "estimate stated", "$0.90"])
      expect(pass.calls[0]!.prompt).toContain(item);
    expect(pass.planRuns()).toBe(1);

    const bad = rubricEngine([GOOD], ['{"verdict":"pass"}']);
    await bad.e.run();
    expect(bad.planRuns()).toBe(1);
    expect(bad.e.github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.awaitingApproval]);
    expect(bad.posted().some((b) => b.includes("rubric reply was not usable"))).toBe(true);

    const claudeOnly = { claude: { preset: "claude" } } as const;
    const missing = rubricEngine([GOOD], [PASS], { ...config, agents: claudeOnly, planCriticAgent: "critic" });
    await missing.e.run();
    expect(missing.calls).toHaveLength(0);
    expect(missing.e.github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.awaitingApproval]);

    // A repo that never set planCriticAgent and has no sonnet agent has not opted into the rubric.
    const unset = rubricEngine([GOOD], [PASS], { ...config, agents: claudeOnly });
    expect(await unset.e.run()).toBe("shipped");
    expect(unset.calls).toHaveLength(0);
  });

  test("revise loop stops after one round", async () => {
    const r = rubricEngine([GOOD, GOOD], [REVISE]);
    await r.e.run();
    expect(r.planRuns()).toBe(2);
    expect(r.calls).toHaveLength(1);
    expect(r.posted().some((b) => b.includes("### Plan check: still open") && b.includes("AC-1 drifts"))).toBe(true);
    expect(r.e.github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.awaitingApproval]);

    // A deterministic revise that comes back clean spends the round, so a rubric revise cannot add another.
    const spent = rubricEngine([BAD, GOOD], [REVISE]);
    await spent.e.run();
    expect(spent.planRuns()).toBe(2);
    expect(spent.calls).toHaveLength(1);
  });

  test("a rubric revise verdict is stored as a pending lesson", async () => {
    const r = rubricEngine([GOOD, GOOD], [REVISE]);
    await r.e.run();
    const lessons = r.e.deps.state.pendingLessons("acme/widgets");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.lesson).toContain("AC-1 drifts from the issue");
    expect(lessons[0]!.outcome).toBe("plan-critic");
  });

  test("a revision that fixes it posts the fixed plan and auto-approves", async () => {
    const e = engine(workflow, 0, {}, {}, {}, { outputs: { plan: [BAD, GOOD] }, config });
    e.deps.executor = {
      runStage: (o: StageRunOptions) =>
        o.prompt === undefined
          ? e.executor.runStage(o as never)
          : Promise.resolve({
              events: [],
              toolCalls: 0,
              tokensIn: 0,
              tokensOut: 0,
              costUsd: 0,
              exitCode: 0,
              permissionDenials: [],
              finalMessage: PASS,
            }),
    };
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
