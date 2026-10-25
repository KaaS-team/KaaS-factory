// Ported from owainlewis/machinist@3943516 internal/controlplane/web/src/task-presentation.test.js (MIT, Copyright (c) 2026 Owain Lewis). Deviations: bun:test instead of node:test.
// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "bun:test";
import { taskPresentation } from "../../../dashboard/public/lib/task-presentation.js";

test("review shows the bound revision, with earlier attempts in history", () => {
  const runs = [{ id: "original" }, { id: "old-gate" }, { id: "revised" }, { id: "gate", reviewed_run_id: "revised" }];
  const view = taskPresentation({
    state: "awaiting_approval",
    runs,
    workflow: { steps: ["plan", "build"], current_step: 1 },
  });
  assert.equal(view.result.id, "revised");
  assert.deepEqual(
    view.history.map((r) => r.id),
    ["original", "old-gate"],
  );
  assert.deepEqual(
    view.stages.map((s) => [s.complete, s.current]),
    [
      [true, false],
      [false, true],
    ],
  );
});

test("initial approval has no fabricated result; running revision shows itself", () => {
  assert.equal(taskPresentation({ state: "awaiting_approval", runs: [{ id: "gate" }] }).result, undefined);
  const view = taskPresentation({ state: "running", runs: [{ id: "original" }, { id: "revision" }] });
  assert.equal(view.result.id, "revision");
  assert.equal(view.history.length, 1);
});

test("successful task marks all stages complete", () => {
  const view = taskPresentation({
    state: "succeeded",
    runs: [{ id: "done" }],
    workflow: { steps: ["plan", "build"], current_step: 1 },
  });
  assert.ok(view.stages.every((s) => s.complete && !s.current));
});
