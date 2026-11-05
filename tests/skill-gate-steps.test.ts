// E13.3: a `skill` step runs a skill as a workflow step, and a `gate: human` step pauses for
// approve, steer or skip.

import { afterAll, describe, expect, test } from "bun:test";
import { parseChatOps } from "../src/chatops";
import { skillPrompt } from "../src/engine/skill-step";
import { parseWorkflowText } from "../src/engine/workflows";
import { LABEL } from "../src/labels";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const load = (text: string) => {
  const parsed = parseWorkflowText(text);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  return parsed.workflow;
};
const problems = (text: string) => {
  const parsed = parseWorkflowText(text);
  return parsed.ok ? [] : parsed.problems;
};

const SKILL_FLOW = `
name: discipline
steps:
  probe:
    uses: skill
    skill: factory-architecture
    label: factory:probing
    next: done
  done:
    uses: report
    label: factory:reporting
`;

describe("skill step", () => {
  test("needs a skill name, and only a skill step takes one", () => {
    expect(problems(SKILL_FLOW.replace("    skill: factory-architecture\n", "")).join()).toContain(
      "steps.probe.skill: required",
    );
    expect(
      problems(SKILL_FLOW.replace("  done:\n    uses: report", "  done:\n    uses: report\n    skill: x")).join(),
    ).toContain("a report step runs no skill");
  });

  test("the prompt carries the skill body without its frontmatter, the issue and the answer shape", () => {
    const p = skillPrompt(
      "---\nname: x\ndescription: d\n---\nDo the thing.\n",
      5,
      "Fix it",
      ".factory/runs/issue-5/probe.json",
    );
    expect(p).toContain("Do the thing.");
    expect(p).not.toContain("description: d");
    expect(p).toContain("Issue #5: Fix it");
    expect(p).toContain('{"ok": true|false');
  });

  async function runSkill(answer: Record<string, unknown> | undefined) {
    const e = engine(
      load(SKILL_FLOW),
      0,
      {},
      {},
      {},
      { outputs: { triage: [answer ? { "probe.json": JSON.stringify(answer) } : {}] } },
    );
    return { e, outcome: await e.run() };
  }

  test("an ok answer goes on to the next step", async () => {
    const { e, outcome } = await runSkill({ ok: true, summary: "clean" });
    expect(outcome).toBe("shipped");
    expect(e.deps.state.listStageRuns("acme/widgets")).toHaveLength(1);
  });

  test("a not-ok answer parks the issue as failed with the skill's reason", async () => {
    const { e, outcome } = await runSkill({ ok: false, summary: "no regression test" });
    expect(outcome).toBe("failed");
    const last = e.github.issues.get(1)!.comments.at(-1)!.body;
    expect(last).toContain("no regression test");
    expect(e.github.issues.get(1)!.labels.map((l) => l.name)).toContain(LABEL.failed);
  });

  test("a skill that is not there fails before any agent runs", async () => {
    const e = engine(load(SKILL_FLOW.replace("factory-architecture", "no-such-skill")), 0);
    expect(await e.run()).toBe("failed");
    expect(e.github.issues.get(1)!.comments.at(-1)!.body).toContain("no-such-skill");
  });
});

const GATE_FLOW = `
name: gated
steps:
  triage:
    uses: triage
    label: factory:triaging
    next: plan
  plan:
    uses: plan
    label: factory:planning
    next: hold
  hold:
    uses: gate
    gate: human
    label: factory:holding
    next:
      - park: awaiting-approval
        approve: build
        revise: plan
        skip: wrap
  build:
    uses: build
    label: factory:building
    next: verify
  verify:
    uses: verify
    label: factory:verifying
    reject: build
    next: pr
  pr:
    uses: pr
    label: factory:opening-pr
  wrap:
    uses: report
    label: factory:wrapping
`;
const planOut = {
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
  "plan.json": JSON.stringify({ risk: "high", revision: 1, files: ["src/a.ts"], autoApproveEligible: false }),
};

describe("gate: human step", () => {
  test("parses only with one park edge that names skip", () => {
    expect(problems(GATE_FLOW)).toEqual([]);
    expect(problems(GATE_FLOW.replace("revise: plan\n        skip: wrap\n", "revise: wrap\n")).join()).toContain(
      "skip: required",
    );
    expect(problems(GATE_FLOW.replace("    gate: human\n", "")).join()).toContain("hold.gate: required");
    expect(problems(GATE_FLOW.replace("uses: gate\n    gate: human", "uses: plan")).join()).toContain(
      "skip: is only for a gate: human step",
    );
  });

  test("/factory skip parses", () => {
    expect(parseChatOps("/factory skip")).toEqual({ type: "skip" });
  });

  const gated = () => engine(load(GATE_FLOW), 0, {}, {}, {}, { outputs: { plan: [planOut, planOut] } });

  test("it pauses the issue and says what approve, revise and skip do", async () => {
    const e = gated();
    expect(await e.run()).toBe("awaiting-approval");
    expect(e.github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.awaitingApproval]);
    const note = e.github.issues
      .get(1)!
      .comments.map((c) => c.body)
      .find((b) => b.includes("Waiting for a person"))!;
    expect(note).toContain("/factory approve");
    expect(note).toContain("/factory revise");
    expect(note).toContain("/factory skip");
  });

  test("approve goes on to build and ships", async () => {
    const e = gated();
    await e.run();
    e.github.say(1, "/factory approve");
    expect(await e.run()).toBe("shipped");
    expect(e.executor.mcp.map(([s]) => s)).toContain("build");
  });

  test("skip jumps past build", async () => {
    const e = gated();
    await e.run();
    e.github.say(1, "/factory skip");
    expect(await e.run()).toBe("shipped");
    expect(e.executor.mcp.map(([s]) => s)).not.toContain("build");
  });

  test("revise steers back to plan and pauses again", async () => {
    const e = gated();
    await e.run();
    e.github.say(1, "/factory revise cover the empty case");
    expect(await e.run()).toBe("awaiting-approval");
    expect(e.executor.mcp.map(([s]) => s).filter((s) => s === "plan")).toHaveLength(2);
  });

  test("a skip from an outsider is ignored", async () => {
    const e = gated();
    await e.run();
    e.github.say(1, "/factory skip", "NONE");
    expect(await e.run()).toBe("waiting");
  });
});
