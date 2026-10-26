// #89: the plan check runs before a plan posts. An AC with no test, or a command build cannot run,
// sends the plan back once on a fork of its session; what is still wrong waits for a human.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import { parseWorkflowText } from "../src/engine/workflows";
import { planMustFix, proofAllowRules } from "../src/engine/plan-critic";
import { LABEL } from "../src/labels";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

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
