// A workflow written as .factory/workflows/<name>.md: frontmatter stages with needs, agent, tools,
// gates and approval become the same steps a .yml file has, and drive a real issue on the engine.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow, parseWorkflowText } from "../src/engine/workflows";
import { LABEL } from "../src/labels";
import { engine, removeEngineDirs } from "./engine-harness";

const clone = mkdtempSync(join(tmpdir(), "factory-md-"));
afterAll(() => {
  rmSync(clone, { recursive: true, force: true });
  removeEngineDirs();
});

const SHIP = `---
name: ship
on:
  cron:
    - schedule: "0 9 * * 1"
      title: Weekly ship
stages:
  pr:
    needs: verify
  triage:
    tools: [docs]
  plan:
    needs: triage
    approval: on-risk:medium
  build:
    needs: plan
    agent: codex
    timeout: 45m
    gates: [lint, unit]
  verify:
    needs: build
---
How we ship a change: triage, a plan a person approves when it is risky, a build held to two gates.
`;

const MCP = { ".factory/mcp.json": JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" } } }) };
const PLAN = (risk: string) => ({
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
  "plan.json": JSON.stringify({ risk, revision: 1, files: ["a"], autoApproveEligible: false }),
});

describe("workflow .md files", () => {
  test("a .md workflow's stages, needs, agent, tools, gates and approval drive an issue", async () => {
    mkdirSync(join(clone, ".factory", "workflows"), { recursive: true });
    writeFileSync(join(clone, ".factory", "workflows", "ship.md"), SHIP);
    const loaded = await loadWorkflow(clone, "ship");
    if (!loaded.ok) throw new Error(loaded.problems.join("; "));
    const wf = loaded.workflow;
    // needs: reorders pr after verify; gates: adds a check step that runs only the named gates.
    expect(Object.keys(wf.steps)).toEqual(["triage", "plan", "build", "build-gates", "verify", "pr"]);
    expect(wf.steps["build-gates"]!.run).toBe("FACTORY_GATES_ONLY=lint,unit bash .factory/gates.sh");
    expect(wf.steps.triage!.mcp).toEqual(["docs"]);
    expect(wf.steps.verify!.reject).toBe("build");
    expect(wf.triggers.cron).toHaveLength(1);
    expect(wf.sha).toMatch(/^[0-9a-f]{12}$/);

    const low = engine(wf, 0, MCP, {}, {}, { outputs: { plan: [PLAN("low")] } });
    expect(await low.run()).toBe("shipped");
    expect(low.executor.pinned).toContainEqual(["build", "codex", 45]);
    expect(low.setupRunner.ran).toContain("FACTORY_GATES_ONLY=lint,unit bash .factory/gates.sh");
    expect(low.github.seenLabels).toContain("factory:build-gates");

    const risky = engine(wf, 0, MCP, {}, {}, { outputs: { plan: [PLAN("high")] } });
    expect(await risky.run()).toBe("awaiting-approval");
    expect(risky.github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.awaitingApproval]);
  });

  test("a .md workflow names every problem in its stages", () => {
    const bad = parseWorkflowText(`---
name: bad
stages:
  build:
    needs: nowhere
    approval: sometimes
    colour: red
---
`);
    expect(bad.ok).toBe(false);
    const problems = bad.ok ? [] : bad.problems;
    expect(problems).toContain('stages.build.needs: no stage "nowhere"');
    expect(problems.some((p) => p.startsWith("stages.build.colour: unknown key"))).toBe(true);
  });
});
