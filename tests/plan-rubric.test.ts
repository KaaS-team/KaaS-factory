// #156: one rubric pass after the model-free checks, at most one revision, reasons kept as a lesson.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LABEL } from "../src/labels";
import { parseWorkflowText } from "../src/engine/workflows";
import { FakeGit, fixtureFor } from "./harness";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const workflow = (() => {
  const text = readFileSync(join(import.meta.dir, "..", "template", ".factory", "workflows", "feature-to-pr.yml"));
  const r = parseWorkflowText(text.toString());
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.workflow;
})();

const SKILL = "---\nname: factory-plan-rubric\ndescription: Grades a plan.\n---\n\n# rubric\nGrade it.\n";
const SKILL_PATH = ".claude/skills/factory-plan-rubric/SKILL.md";

class SkillGit extends FakeGit {
  constructor(private readonly commit: boolean) {
    super();
  }
  override async ensureWorktree(cloneDir: string, worktreeDir: string, issue: number): Promise<void> {
    await super.ensureWorktree(cloneDir, worktreeDir, issue);
    const path = join(worktreeDir, SKILL_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SKILL);
    if (!this.commit) return;
    const sh = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: worktreeDir });
    sh("init", "-q");
    sh("add", "-A");
    sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  }
}

const plan = (cmd: string) => ({
  "plan-comment.md": [
    "<!-- factory:plan v1 rev=1 -->",
    "## Plan (rev 1)",
    "### Acceptance criteria",
    `- **AC-1:** x: checked by \`${cmd}\``,
    "### Tests to write first",
    "- `test/a.test.ts`",
    "### Risk: low",
  ].join("\n"),
  "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true }),
});
const GOOD = plan("npm test");
const BAD = plan("node --test t.mjs");
const rubric = (body: object | string) => ({
  "plan-rubric.json": typeof body === "string" ? body : JSON.stringify(body),
});
const REVISE = rubric({ verdict: "revise", reasons: ["Scope: drop the extra file.", "Estimate: state a size."] });

const config = {
  agentCommands: {
    read: ["git ls-tree *"],
    build: ["npm *", "make *"],
    verify: ["npm *", "make *"],
  },
  toggles: { autoApproveLowRisk: true },
};

// Queues each plan-stage output with its own session id, in run order.
function run(outputs: Array<Record<string, string>>, committed = true) {
  const git = new SkillGit(committed);
  const e = engine(workflow, 0, {}, {}, { git }, { config });
  outputs.forEach((files, i) => e.executor.push("plan", 1, fixtureFor("plan", 1), files, { sessionId: `s${i + 1}` }));
  return e;
}
const planRuns = (e: ReturnType<typeof run>) => e.executor.pinned.filter(([s]) => s === "plan");
const lessons = (e: ReturnType<typeof run>) => e.deps.state.pendingLessons(e.config.repo);

describe("the plan rubric", () => {
  test("a pass costs one extra run and keeps no lesson", async () => {
    const e = run([GOOD, rubric({ verdict: "pass", reasons: [] })]);
    expect(await e.run()).toBe("shipped");
    expect(planRuns(e)).toHaveLength(2);
    expect(lessons(e)).toHaveLength(0);
    expect(e.github.issues.get(1)!.comments.some((c) => c.body.includes("checked by `npm test`"))).toBe(true);
  });

  test("a revise sends the plan back once on the first plan session and keeps one lesson", async () => {
    const e = run([GOOD, REVISE, GOOD]);
    expect(await e.run()).toBe("shipped");
    expect(planRuns(e)).toHaveLength(3);
    const resume = e.executor.resumed.find((r) => r?.failure.includes("plan check"));
    expect(resume?.sessionId).toBe("s1");
    expect(resume?.failure).toContain("Plan rubric: Scope: drop the extra file.");
    expect(resume?.failure).toContain("Plan rubric: Estimate: state a size.");
    const rows = lessons(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("plan-rubric");
    expect(rows[0]!.lesson).toContain("Scope: drop the extra file.");
    expect(rows[0]!.lesson).toContain("Estimate: state a size.");
  });

  test("a revision that still fails a model-free check waits for a human after exactly three runs", async () => {
    const e = run([GOOD, REVISE, BAD]);
    await e.run();
    expect(planRuns(e)).toHaveLength(3);
    expect(e.github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.awaitingApproval]);
    expect(e.github.issues.get(1)!.comments.some((c) => c.body.includes("### Plan check: still open"))).toBe(true);
  });

  test("a missing or invalid verdict fails open: the plan posts unchanged", async () => {
    for (const out of [{}, rubric("not json"), rubric({ verdict: "maybe", reasons: [] })]) {
      const e = run([GOOD, out]);
      expect(await e.run()).toBe("shipped");
      expect(planRuns(e)).toHaveLength(2);
      expect(lessons(e)).toHaveLength(0);
    }
  });

  test("a skill that is present but not committed does not run", async () => {
    const e = run([GOOD], false);
    expect(await e.run()).toBe("shipped");
    expect(planRuns(e)).toHaveLength(1);
  });
});
