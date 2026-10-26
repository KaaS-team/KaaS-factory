// The workflow comes from the type label an issue was filed with. An issue filed with none gets its
// type from triage, and that type's route switches it once; a type label added later, or a second
// triage, never switches it again.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadWorkflow } from "../src/engine/workflows";
import { LABEL } from "../src/labels";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const bundled = async (name: string) => {
  const r = await loadWorkflow(join(import.meta.dir, "..", "template"), name);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.workflow;
};

const TRIAGE_DOCS = {
  "triage-comment.md": "<!-- factory:triage v1 -->\nt",
  "triage.json": JSON.stringify({
    disposition: "proceed",
    type: "docs",
    risk: "low",
    done_when: "x",
    files_expected: ["a"],
    gate_level: "x",
    confidence: 0.9,
  }),
};

async function setup(labels: string[]) {
  const [feature, docs] = [await bundled("feature-to-pr"), await bundled("docs-to-pr")];
  return engine(
    feature,
    0,
    {},
    {},
    { routeWorkflows: { "docs-to-pr": docs } },
    { labels, config: { routes: { docs: { workflow: "docs-to-pr" } } }, outputs: { triage: [TRIAGE_DOCS] } },
  );
}

describe("workflow from a late type", () => {
  test("an issue filed with no type label runs the workflow its triaged type routes to", async () => {
    const e = await setup([LABEL.ready]);
    expect(await e.run()).toBe("shipped");
    const stages = e.executor.pinned.map(([s]) => s);
    // docs-to-pr has no plan and no verify; feature-to-pr has both.
    expect(stages).toEqual(["triage", "build", "pr"]);
    expect(e.github.issues.get(1)!.comments.some((c) => c.body.includes("Running workflow `docs-to-pr`"))).toBe(true);
  });

  test("an issue filed with a type label keeps the workflow that label chose", async () => {
    const e = await setup([LABEL.ready, "feature"]);
    e.executor.push("plan", 1, (await import("./harness")).fixtureFor("plan", 1), {
      "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
      "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true }),
    });
    await e.run();
    expect(e.executor.pinned.map(([s]) => s)).toContain("plan");
    expect(e.github.issues.get(1)!.comments.some((c) => c.body.includes("Running workflow"))).toBe(false);
  });
});
