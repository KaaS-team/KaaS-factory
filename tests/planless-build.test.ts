// Scenario: every shipped workflow, with or without a plan step, can be built by the build skill.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasPlanStep, planlessBuildProblems } from "../src/engine/planless-build";
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
});
