// The self-improvement loop may add and edit files; it never deletes one or edits calibration labels.
import { expect, test } from "bun:test";
import { loopRefusals } from "../src/loop-guard";

test("the loop guard refuses deletions and calibration labels, not additions or edits", () => {
  const exists = (f: string) => f !== ".claude/skills/gone/SKILL.md";
  expect(loopRefusals([".factory/memory/lessons.md", ".claude/skills/a/SKILL.md"], exists)).toEqual([]);
  expect(loopRefusals([".claude/skills/gone/SKILL.md"], exists)).toEqual([".claude/skills/gone/SKILL.md: deleted"]);
  expect(loopRefusals(["tests/fixtures/judge-calibration/cases.json"], () => true)).toEqual([
    "tests/fixtures/judge-calibration/cases.json: calibration label",
  ]);
});
