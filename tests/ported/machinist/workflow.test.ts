// Ported from owainlewis/machinist@3943516 internal/runner/workflow_test.go:12-40 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the shell-script agent is replaced by the artifact file it would have written; "nonzero overrides result" is a runner rule and is asserted in tests/scenarios.test.ts (14c); the 16 KiB and one-object rules from protocol/workflow.go are added here.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_STEP_JSON_BYTES, readStageArtifacts, runDir, stepStop, validateStepJson } from "../../../src/artifacts";

const dir = mkdtempSync(join(tmpdir(), "factory-step-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function readBuild(body: string | undefined, issue: number) {
  mkdirSync(join(dir, runDir(issue)), { recursive: true });
  if (body !== undefined) writeFileSync(join(dir, runDir(issue), "build.json"), body);
  return (await readStageArtifacts(dir, issue, "build")).json;
}

test("complete: a valid step result is read and does not stop the run", async () => {
  const json = await readBuild(
    '{"outcome":"complete","summary":"PR created","status":"green","gate_line":"ok","rounds":1}',
    1,
  );
  expect(validateStepJson("build", json)).toEqual({ ok: true });
  expect(stepStop(json as never)).toBeUndefined();
});

test("blocked: the summary becomes the reason the run parks", async () => {
  const json = await readBuild('{"outcome":"blocked","summary":"Need requirements"}', 2);
  expect(validateStepJson("build", json)).toEqual({ ok: true });
  expect(stepStop(json as never)).toEqual({ status: "needs-human", reason: "Need requirements" });
});

test("missing: no file reads as no result", async () => {
  expect(await readBuild(undefined, 3)).toBeUndefined();
});

test("invalid: an outcome outside complete|blocked|failed is refused", async () => {
  const json = await readBuild('{"outcome":"approved","summary":"ok"}', 4);
  expect(validateStepJson("build", json)).toEqual({
    ok: false,
    reason: "build.json: step outcome must be complete, blocked, or failed",
  });
});

test("a summary must not be blank, and unknown fields are refused", () => {
  expect(validateStepJson("build", { outcome: "complete", summary: "  " }).ok).toBe(false);
  expect(validateStepJson("build", { outcome: "complete", extra: 1 })).toEqual({
    ok: false,
    reason: 'build.json has unknown field "extra"',
  });
});

test("more than one JSON object, or a body over 16 KiB, reads as no result", async () => {
  expect(await readBuild('{"outcome":"complete"}{"outcome":"complete"}', 5)).toBeUndefined();
  expect(
    await readBuild(JSON.stringify({ outcome: "complete", summary: "x".repeat(MAX_STEP_JSON_BYTES) }), 6),
  ).toBeUndefined();
});
