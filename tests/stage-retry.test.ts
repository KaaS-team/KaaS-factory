// A stage whose JSON is present but invalid is run once more with every problem listed, then hard-fails
// with the whole list recorded. Driven through the real triage step.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepProblems } from "../src/artifacts";
import { loadWorkflow } from "../src/engine/workflows";
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
const triage = (json: object) => ({
  "triage-comment.md": "<!-- factory:triage v1 -->\nt",
  "triage.json": JSON.stringify(json),
});
// Three independent problems: a bad enum, a wrong type and an unknown field.
const bad = { ...good, risk: "extreme", confidence: "high", colour: "red" };

async function setup(outputs: Array<Record<string, string>>) {
  const r = await loadWorkflow(join(import.meta.dir, "..", "template"), "docs-to-pr");
  if (!r.ok) throw new Error(r.problems.join("; "));
  return engine(r.workflow, 0, {}, {}, {}, { outputs: { triage: outputs } });
}

describe("stage output retry", () => {
  test("stepProblems lists every problem, not the first", () => {
    const problems = stepProblems("triage", bad);
    expect(problems).toEqual([
      'triage.json has unknown field "colour"',
      'triage.json: "risk" has the wrong type or value',
      'triage.json: "confidence" has the wrong type or value',
    ]);
  });

  test("one retry carries the full list, and a valid second output goes on", async () => {
    const e = await setup([triage(bad), triage(good)]);
    await e.run();
    const stages = e.executor.pinned.map(([s]) => s);
    expect(stages.filter((s) => s === "triage")).toHaveLength(2);
    const resume = e.executor.resumed[1];
    expect(resume?.failure).toContain('- triage.json has unknown field "colour"');
    expect(resume?.failure).toContain('- triage.json: "risk" has the wrong type or value');
    expect(resume?.failure).toContain('- triage.json: "confidence" has the wrong type or value');
    expect(e.executor.resumed[0] === undefined).toBe(true);
  });

  test("a second failure hard-fails the stage and records every problem", async () => {
    const e = await setup([triage(bad), triage(bad), triage(good)]);
    expect(await e.run()).toBe("failed");
    expect(e.executor.pinned.filter(([s]) => s === "triage")).toHaveLength(2);
    const reason = e.deps.state.getRun("acme/widgets", 1)?.reason;
    expect(reason).toContain('triage.json has unknown field "colour"');
    expect(reason).toContain('"risk" has the wrong type or value');
    expect(reason).toContain('"confidence" has the wrong type or value');
  });

  test("a valid first output is not retried", async () => {
    const e = await setup([triage(good)]);
    await e.run();
    expect(e.executor.pinned.filter(([s]) => s === "triage")).toHaveLength(1);
  });
});
