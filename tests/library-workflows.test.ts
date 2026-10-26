// The library workflows that use the step types and keys .md workflows added (report, gates,
// approval, needs, an event trigger) ship with the runner, load clean and drive an issue.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow } from "../src/engine/workflows";
import { harnessReport } from "../src/harness";
import { LABEL } from "../src/labels";
import { engine, removeEngineDirs } from "./engine-harness";

const empty = mkdtempSync(join(tmpdir(), "factory-library-"));
afterAll(() => {
  rmSync(empty, { recursive: true, force: true });
  removeEngineDirs();
});

// The goal's list; flaky-test is the bundled flaky-tests.
const LIBRARY = [
  ...["pr-review", "test-authoring", "coverage-gap", "flaky-tests", "dependency-update", "ci-fix"],
  ...["ci-cd-authoring", "release-notes", "harness-learn", "ui-component", "spec-to-plan", "backlog-triage"],
];
const PLAN = {
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
  "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true }),
};

async function bundled(name: string) {
  const loaded = await loadWorkflow(empty, name);
  if (!loaded.ok) throw new Error(`${name}: ${loaded.problems.join("; ")}`);
  return loaded.workflow;
}

describe("library workflows", () => {
  test("every library workflow ships with the runner, loads clean and is listed by harness validate", async () => {
    const report = await harnessReport(empty, { workflow: "feature-to-pr", routes: {} });
    expect(report.problems).toEqual([]);
    for (const name of LIBRARY) {
      expect(report.entries.find((e) => e.name === name)).toMatchObject({ source: "runner", problems: [] });
      expect((await bundled(name)).name).toBe(name);
    }
    expect((await bundled("pr-review")).triggers.event).toEqual(["factory.pr.opened"]);
    for (const name of ["coverage-gap", "release-notes", "harness-learn", "backlog-triage"])
      expect((await bundled(name)).triggers.cron.length).toBe(1);
  });

  test("report workflows close the issue with no PR, and ci-cd-authoring parks every plan", async () => {
    for (const name of ["spec-to-plan", "pr-review"]) {
      const e = engine(await bundled(name), 0, {}, {}, {}, { outputs: { plan: [PLAN] } });
      expect(await e.run()).toBe("shipped");
      expect(e.github.closed).toContain(1);
      expect(e.github.createdPrs).toHaveLength(0);
    }
    const triageOnly = engine(await bundled("backlog-triage"), 0);
    expect(await triageOnly.run()).toBe("shipped");
    expect(triageOnly.executor.pinned.map(([stage]) => stage)).toEqual(["triage"]);

    const gated = engine(await bundled("test-authoring"), 0, {}, {}, {}, { outputs: { plan: [PLAN] } });
    expect(await gated.run()).toBe("shipped");
    expect(gated.setupRunner.ran).toContain("FACTORY_GATES_ONLY=unit bash .factory/gates.sh");

    const cicd = engine(
      await bundled("ci-cd-authoring"),
      0,
      {},
      {},
      {},
      {
        outputs: { plan: [PLAN] },
        config: { toggles: { autoApproveLowRisk: true } },
      },
    );
    await cicd.run();
    expect(cicd.github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.awaitingApproval]);
    expect(cicd.github.seenLabels).not.toContain(LABEL.building);
  });
});
