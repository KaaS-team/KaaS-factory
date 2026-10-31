// R1b: a plan step on an issue whose body is unchanged since its last plan reuses that plan.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withDataMarker } from "../src/engine/common";
import { sha256 } from "../src/engine/import-plan";
import { reusablePlan } from "../src/engine/plan-reuse";
import { parseWorkflowText } from "../src/engine/workflows";
import { baseIssue } from "./harness";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const workflow = (() => {
  const text = readFileSync(join(import.meta.dir, "..", "template", ".factory", "workflows", "feature-to-pr.yml"));
  const r = parseWorkflowText(text.toString());
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.workflow;
})();

const BODY = "do the thing";
const PRIOR_TEXT = "<!-- factory:plan v1 rev=1 -->\n## Plan (rev 1)\nprior plan text\n### Risk: low";
const priorJson = (bodyHash?: string, extra: object = {}) => ({
  risk: "low",
  revision: 1,
  files: ["a"],
  autoApproveEligible: true,
  ...(bodyHash ? { bodyHash } : {}),
  ...extra,
});
const NEW_PLAN = {
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\n## Plan (rev 1)\nfresh plan\n### Risk: low",
  "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true }),
};
const config = { toggles: { autoApproveLowRisk: true } };

const planRuns = (e: ReturnType<typeof engine>) => e.executor.pinned.filter(([s]) => s === "plan");
const bodies = (e: ReturnType<typeof engine>) => e.github.issues.get(1)!.comments.map((c) => c.body);

function seeded(hash: string | undefined, afterPlan?: string) {
  const e = engine(workflow, 0, {}, {}, {}, { outputs: { plan: [NEW_PLAN] }, config });
  e.github.say(1, withDataMarker(PRIOR_TEXT, "plan", priorJson(hash)));
  if (afterPlan) e.github.say(1, afterPlan);
  return e;
}

describe("the plan step reuses an unchanged plan", () => {
  test("the same body: no plan run, and the posted plan says it was reused", async () => {
    const e = seeded(sha256(BODY));
    await e.run();
    expect(planRuns(e)).toHaveLength(0);
    const posted = bodies(e).filter((b) => b.includes("Plan reused"));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("prior plan text");
  });

  test("a changed body plans afresh", async () => {
    const e = seeded(sha256("an older body"));
    await e.run();
    expect(planRuns(e)).toHaveLength(1);
  });

  test("a revise after the plan plans afresh", async () => {
    const e = seeded(sha256(BODY), "/factory revise tighten AC-1");
    await e.run();
    expect(planRuns(e)).toHaveLength(1);
  });

  test("a planner run with no prior plan stamps the body hash", async () => {
    const e = engine(workflow, 0, {}, {}, {}, { outputs: { plan: [NEW_PLAN] }, config });
    await e.run();
    expect(planRuns(e)).toHaveLength(1);
    const marker = bodies(e).find((b) => b.includes("fresh plan"))!;
    expect(marker).toContain(`"bodyHash":"${sha256(BODY)}"`);
  });
});

describe("reusablePlan", () => {
  const issueWith = (comments: Array<{ body: string; authorAssociation: string }>) => ({
    ...baseIssue(1, []),
    comments: comments.map((c, id) => ({ id, author: "x", createdAt: "2026-01-01T00:00:00Z", ...c })),
  });
  const marked = (json: object) => withDataMarker(PRIOR_TEXT, "plan", json);

  test("a plan from an untrusted commenter is ignored", () => {
    const issue = issueWith([{ body: marked(priorJson(sha256(BODY))), authorAssociation: "NONE" }]);
    expect(reusablePlan(issue)).toBeUndefined();
  });

  test("a needs-info plan is not reused", () => {
    const issue = issueWith([
      { body: marked(priorJson(sha256(BODY), { status: "needs-info" })), authorAssociation: "OWNER" },
    ]);
    expect(reusablePlan(issue)).toBeUndefined();
  });

  test("a trusted plan with the body's hash is reused without its data marker", () => {
    const issue = issueWith([{ body: marked(priorJson(sha256(BODY))), authorAssociation: "OWNER" }]);
    expect(reusablePlan(issue)?.comment).toBe(PRIOR_TEXT);
  });
});
