// The lane: a pure size and path check, and the real runner skipping optional steps on a lite
// change, running them on a full one, and escalating when the build outgrows what triage expected.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { LITE_MAX_CHANGED_LINES, LITE_MAX_FILES, chooseLane } from "../src/engine/lane";
import { parseWorkflowText } from "../src/engine/workflows";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);
// A rerun finds the per-run temp root gone; the harness makes its dirs inside it.
beforeEach(() => mkdirSync(tmpdir(), { recursive: true }));

const WORKFLOW = `
name: lane-test
steps:
  triage: { uses: triage, label: "factory:triaging", next: build }
  build: { uses: build, label: "factory:building", next: verify }
  verify: { uses: verify, label: "factory:verifying", optional: true, next: pr, reject: build }
  pr: { uses: pr, label: "factory:in-review", revise: build }
`;
const workflow = () => {
  const r = parseWorkflowText(WORKFLOW);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.workflow;
};
const triage = (files: string[]) => ({
  "triage-comment.md": "<!-- factory:triage v1 -->\nt",
  "triage.json": JSON.stringify({
    disposition: "proceed",
    type: "bug",
    risk: "low",
    done_when: "x",
    files_expected: files,
    gate_level: "x",
    confidence: 0.9,
  }),
});
const stagesOf = (e: ReturnType<typeof engine>) => e.executor.pinned.map(([s]) => s);

describe("chooseLane", () => {
  test("a small change off the protected paths is lite", () => {
    expect(chooseLane({ files: ["src/a.ts"], changedLines: 5 }, []).lane).toBe("lite");
  });
  test("a protected path is full however small", () => {
    expect(chooseLane({ files: ["src/pay/a.ts"], changedLines: 1 }, ["src/pay/**"]).lane).toBe("full");
    expect(chooseLane({ files: [".factory/config.json"] }, []).lane).toBe("full");
  });
  test("one file or one line over a cap is full", () => {
    const many = Array.from({ length: LITE_MAX_FILES + 1 }, (_, i) => `f${i}.ts`);
    expect(chooseLane({ files: many }, []).lane).toBe("full");
    expect(chooseLane({ files: ["a.ts"], changedLines: LITE_MAX_CHANGED_LINES }, []).lane).toBe("lite");
    expect(chooseLane({ files: ["a.ts"], changedLines: LITE_MAX_CHANGED_LINES + 1 }, []).lane).toBe("full");
  });
  test("an unknown size is full", () => {
    expect(chooseLane({ files: [] }, []).lane).toBe("full");
  });
});

describe("the lane in a run", () => {
  test("a lite change skips the optional step", async () => {
    const e = engine(workflow(), 0, {}, {}, {}, { outputs: { triage: [triage(["src/a.ts"])] } });
    e.git.changed = ["src/a.ts"];
    expect(await e.run()).toBe("shipped");
    expect(stagesOf(e)).toEqual(["triage", "build", "pr"]);
  });

  test("a protected path in triage's expected files always takes the full lane", async () => {
    const e = engine(
      workflow(),
      0,
      {},
      {},
      {},
      { config: { protectedPaths: ["src/pay/**"] }, outputs: { triage: [triage(["src/pay/a.ts"])] } },
    );
    await e.run();
    expect(stagesOf(e)).toContain("verify");
  });

  test("a build that outgrows triage's expected files escalates lite to full", async () => {
    const e = engine(workflow(), 0, {}, {}, {}, { outputs: { triage: [triage(["src/a.ts"])] } });
    e.git.diffStatOverride = [{ path: "src/a.ts", additions: LITE_MAX_CHANGED_LINES + 1, deletions: 0 }];
    await e.run();
    expect(stagesOf(e)).toContain("verify");
  });

  test("a build that touches a protected path escalates lite to full", async () => {
    const e = engine(
      workflow(),
      0,
      {},
      {},
      {},
      { config: { protectedPaths: ["src/pay/**"] }, outputs: { triage: [triage(["src/a.ts"])] } },
    );
    e.git.diffStatOverride = [{ path: "src/pay/b.ts", additions: 1, deletions: 0 }];
    await e.run();
    expect(stagesOf(e)).toContain("verify");
  });

  test("optional on a terminal step is refused", () => {
    const r = parseWorkflowText(
      WORKFLOW.replace('label: "factory:in-review"', 'label: "factory:in-review", optional: true'),
    );
    expect(r.ok).toBe(false);
  });
});
