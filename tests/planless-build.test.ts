// Scenario: every shipped workflow, with or without a plan step, can be built by the build skill.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInputProblems, hasPlanStep, planlessBuildProblems } from "../src/engine/planless-build";
import { BUNDLED_DIR, parseWorkflowText } from "../src/engine/workflows";

const skill = readFileSync(join(import.meta.dir, "../template/.claude/skills/factory-build/SKILL.md"), "utf8");
const files = readdirSync(BUNDLED_DIR).filter((f) => /\.(yml|md)$/.test(f));

describe("build without a plan step", () => {
  test("the walk finds the workflows with no plan step", () => {
    const planless = files.filter((f) => {
      const parsed = parseWorkflowText(readFileSync(join(BUNDLED_DIR, f), "utf8"));
      return (
        parsed.ok &&
        !hasPlanStep(parsed.workflow) &&
        Object.values(parsed.workflow.steps).some((s) => s.uses === "build")
      );
    });
    for (const name of ["bug-to-pr.yml", "docs-to-pr.yml", "dependency-update.yml", "flaky-tests.yml"])
      expect(planless).toContain(name);
  });

  for (const f of files) {
    const parsed = parseWorkflowText(readFileSync(join(BUNDLED_DIR, f), "utf8"));
    if (!parsed.ok) throw new Error(`${f}: ${parsed.problems.join("; ")}`);
    const builds = Object.values(parsed.workflow.steps).some((s) => s.uses === "build");
    if (!builds || hasPlanStep(parsed.workflow)) continue;
    test(`${f}: build never needs a plan.json the workflow cannot write`, () => {
      expect(planlessBuildProblems(skill)).toEqual([]);
    });
  }

  for (const f of files) {
    test(`${f}: has a path from start to build through an input step`, () => {
      const parsed = parseWorkflowText(readFileSync(join(BUNDLED_DIR, f), "utf8"));
      if (!parsed.ok) throw new Error(`${f}: ${parsed.problems.join("; ")}`);
      expect(buildInputProblems(parsed.workflow)).toEqual([]);
    });
  }

  test("a workflow with a build step and no input source fails, naming the workflow", () => {
    const parsed = parseWorkflowText(
      "name: lonely\nsteps:\n  build:\n    uses: build\n    label: factory:building\n    next: verify\n  verify:\n    uses: verify\n    label: factory:verifying\n    next: pr\n    reject: build\n  pr:\n    uses: pr\n    label: factory:in-review\n    revise: build\n",
    );
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    expect(buildInputProblems(parsed.workflow).join("\n")).toContain("lonely");
  });
});
