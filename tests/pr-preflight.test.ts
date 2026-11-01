import { afterAll, describe, expect, test } from "bun:test";
import { defaultWorkflow } from "../src/engine/workflows";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const plan = (extra: Record<string, unknown>) => ({
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
  "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true, ...extra }),
});
const make = (extra: Record<string, unknown>, changed: string[]) => {
  const e = engine(defaultWorkflow(), 0, {}, {}, {}, { outputs: { plan: [plan(extra)] } });
  e.git.changed = changed;
  return e;
};
const thread = (e: ReturnType<typeof make>) =>
  e.github.issues
    .get(1)!
    .comments.map((c) => c.body)
    .join("\n");
const REFUSAL =
  "boundary_record_missing: the plan flags a boundary change but the diff adds no docs/decisions/*.md decision record";

describe("pr preflight, through the pr step", () => {
  test("a flagged plan with no record fails before the pr agent runs", async () => {
    const e = make({ boundaryChange: true }, ["src/a.ts"]);
    expect(await e.run()).toBe("failed");
    expect(thread(e)).toContain(REFUSAL);
    expect(e.github.createdPrs).toHaveLength(0);
    expect(e.executor.mcp.filter(([stage]) => stage === "pr")).toHaveLength(0);
  });

  test("a flagged plan with a record ships", async () => {
    const e = make({ boundaryChange: true }, ["src/a.ts", "docs/decisions/0001-x.md"]);
    expect(await e.run()).toBe("shipped");
    expect(e.github.createdPrs).toHaveLength(1);
  });

  test("an unflagged plan touching no decision path ships without a record", async () => {
    const e = make({ boundaryChange: false }, ["src/a.ts"]);
    expect(await e.run()).toBe("shipped");
    expect(e.github.createdPrs).toHaveLength(1);
  });

  for (const path of ["docs/decisions/new.md", "docs/adr/0002-x.md", "docs/architecture/overview.md"]) {
    test(`an unflagged plan whose files name ${path} is treated as flagged`, async () => {
      const e = make({ boundaryChange: false, files: ["a", path] }, ["src/a.ts"]);
      expect(await e.run()).toBe("failed");
      expect(thread(e)).toContain(REFUSAL);
      expect(e.github.createdPrs).toHaveLength(0);
    });
  }

  test("a README under docs/decisions does not count as the record", async () => {
    const e = make({ boundaryChange: true }, ["src/a.ts", "docs/decisions/README.md"]);
    expect(await e.run()).toBe("failed");
    expect(thread(e)).toContain(REFUSAL);
  });
});
