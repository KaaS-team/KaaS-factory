import { afterAll, describe, expect, test } from "bun:test";
import { defaultWorkflow, workflowFor } from "../src/engine/workflows";
import { LABEL } from "../src/labels";
import { engine, removeEngineDirs } from "./engine-harness";
import { validBody } from "./plan-guard.test";

afterAll(removeEngineDirs);

const COMMANDS = { read: [], build: ["make *"], verify: ["make *"] };
// The fixture names files as existing; the run reads them from the worktree.
const allNew = async () =>
  (await validBody())
    .replace("- `src/engine/failure.ts`", "- `src/engine/failure.ts` (new)")
    .replace("- `src/derive.ts`", "- `src/derive.ts` (new)");

const run = async (body: string) => {
  const planned = await workflowFor(import.meta.dir, { workflow: "planned-to-pr" });
  const e = engine(
    defaultWorkflow(),
    0,
    {},
    {},
    { routeWorkflows: { "planned-to-pr": planned } },
    { config: { agentCommands: COMMANDS } },
  );
  e.github.issues.get(1)!.body = body;
  return { e, outcome: await e.run() };
};

describe("the plan guard at run start", () => {
  test("a stub plan ends in needs-human with no agent step executed", async () => {
    const { e, outcome } = await run("<!-- factory:planned v1 -->\n## Why\nx\n");
    expect(outcome).toBe("needs-human");
    expect(e.executor.mcp).toHaveLength(0);
    const comments = e.github.issues
      .get(1)!
      .comments.map((c) => c.body)
      .join("\n");
    expect(comments).toContain("bytes");
    expect(comments).toContain(`"## Change"`);
    expect(e.github.seenLabels).toContain(LABEL.needsHuman);
  });

  test("a valid plan runs on", async () => {
    const { e, outcome } = await run(await allNew());
    expect(outcome).toBe("shipped");
    expect(e.github.createdPrs).toHaveLength(1);
  });
});
