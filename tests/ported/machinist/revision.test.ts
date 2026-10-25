// Ported from owainlewis/machinist@3943516 internal/runner/revision_test.go:12-19 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the script-executor case (TestScriptRevisionPreservesJSONInput) is not ported; the factory has no script executor.

import { expect, test } from "bun:test";
import { revisionPrompt } from "../../../src/revision";

test("revision prompt keeps feedback literal and includes saved files", () => {
  const got = revisionPrompt(
    {
      previousRun: "run_old",
      feedback: "Keep {{task.spec}} literal",
      previousSummary: "Original plan",
      priorFeedback: ["Keep compatibility"],
      artifacts: { old: "plan.md" },
    },
    { old: "/private/inputs/old" },
  );
  for (const want of [
    "run_old",
    "Keep {{task.spec}} literal",
    "Keep compatibility",
    "plan.md",
    "/private/inputs/old",
  ]) {
    expect(got).toContain(want);
  }
});

test("no revision produces no prompt", () => {
  expect(revisionPrompt(undefined, {})).toBe("");
});
