// Triage confidence gates dispatch: below the threshold the issue is parked with a plain comment, at or
// above it (or with no value) the run goes on. Driven through the real triage step.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow } from "../src/engine/workflows";
import { DEFAULT_TRIAGE_MIN_CONFIDENCE, triageMinConfidence, triageParking } from "../src/triage-confidence";
import { engine, removeEngineDirs } from "./engine-harness";

mkdirSync(tmpdir(), { recursive: true });
afterAll(removeEngineDirs);

const good = {
  disposition: "proceed",
  type: "docs",
  risk: "low",
  done_when: "x",
  files_expected: ["a"],
  gate_level: "x",
  confidence: 0.9,
};
const triage = (json: object, question?: string) => ({
  "triage-comment.md": "<!-- factory:triage v1 -->\nt",
  "triage.json": JSON.stringify(json),
  ...(question ? { "question-comment.md": question } : {}),
});

async function setup(outputs: Array<Record<string, string>>) {
  const r = await loadWorkflow(join(import.meta.dir, "..", "template"), "docs-to-pr");
  if (!r.ok) throw new Error(r.problems.join("; "));
  return engine(r.workflow, 0, {}, {}, {}, { outputs: { triage: outputs } });
}

describe("triage confidence gate", () => {
  test("threshold comes from the env, with a default for a bad value", () => {
    expect(triageMinConfidence({})).toBe(DEFAULT_TRIAGE_MIN_CONFIDENCE);
    expect(triageMinConfidence({ FACTORY_TRIAGE_MIN_CONFIDENCE: "0.8" })).toBe(0.8);
    expect(triageMinConfidence({ FACTORY_TRIAGE_MIN_CONFIDENCE: "2" })).toBe(DEFAULT_TRIAGE_MIN_CONFIDENCE);
    expect(triageMinConfidence({ FACTORY_TRIAGE_MIN_CONFIDENCE: "abc" })).toBe(DEFAULT_TRIAGE_MIN_CONFIDENCE);
  });

  test("parking: below parks with the questions, at the threshold and missing do not", () => {
    expect(triageParking({ confidence: 0.4 }, "Which file?", 0.5)?.comment).toContain("Which file?");
    expect(triageParking({ confidence: 0.5 }, undefined, 0.5)).toBe(undefined);
    expect(triageParking({}, undefined, 0.5)).toBe(undefined);
  });

  test("a low confidence parks the issue and never reaches a later stage", async () => {
    const e = await setup([triage({ ...good, confidence: 0.2 }, "Which page is meant?")]);
    expect(await e.run()).toBe("needs-human");
    const stages = e.executor.pinned.map(([s]) => s);
    expect(stages).toEqual(["triage"]);
    expect(e.deps.state.getRun("acme/widgets", 1)?.reason).toContain("below the threshold");
  });

  test("a confidence at or above the threshold goes on to the next stage", async () => {
    const e = await setup([triage(good)]);
    await e.run();
    expect(e.executor.pinned.map(([s]) => s).filter((s) => s !== "triage").length > 0).toBe(true);
  });
});
