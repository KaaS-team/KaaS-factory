import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { depRefs, unmetDeps } from "../src/plan-deps";
import { baseIssue, FakeGitHub } from "./harness";
import { defaultWorkflow, workflowFor } from "../src/engine/workflows";
import { engine, removeEngineDirs } from "./engine-harness";
import { validBody } from "./plan-guard.test";

const dirs: string[] = [];
afterAll(() => {
  removeEngineDirs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const main = (files: string[] = []) => {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "plan-deps-"));
  dirs.push(dir);
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "x");
  }
  return dir;
};
const issue = (n: number, extra: Partial<ReturnType<typeof baseIssue>> = {}) => ({ ...baseIssue(n, []), ...extra });
const withDeps = (header: string) =>
  `<!-- factory:planned v1 -->\nMilestone: M1\n${header}\n\n## Why\nx\n\n## Change\n### T1: a\nFiles: \`a.ts\`\nModel: haiku\nDeps: #7 T2\n1. do\n`;

describe("depRefs", () => {
  test("reads the header and task Deps lines, not prose", () => {
    const body = withDeps("Deps: #5, #6 T1") + "\nDeps: #99 in prose is a heading-less line\n";
    expect(depRefs(body)).toEqual([{ issue: 5 }, { issue: 6, task: "T1" }, { issue: 7, task: "T2" }]);
    expect(depRefs(withDeps("Deps: none"))).toEqual([{ issue: 7, task: "T2" }]);
  });
});

describe("unmetDeps", () => {
  const gh = new FakeGitHub([
    issue(5, { state: "CLOSED", stateReason: "COMPLETED" }),
    issue(6, { state: "OPEN" }),
    issue(7, {
      state: "OPEN",
      body: "<!-- factory:planned v1 -->\n## Change\n### T2: b\nFiles: `src/b.ts`\nModel: haiku\n1. x\n",
    }),
  ]);

  test("a closed dependency, or none, passes", async () => {
    expect(await unmetDeps("Deps: #5\n", gh, "a/b", main())).toEqual([]);
    expect(await unmetDeps("Deps: none\n", gh, "a/b", main())).toEqual([]);
  });

  test("an open dependency is refused and named", async () => {
    expect(await unmetDeps("Deps: #6\n", gh, "a/b", main())).toEqual([
      "Dependency #6 is not merged: the issue is not closed.",
    ]);
  });

  test("a missing issue is unmet", async () => {
    expect(await unmetDeps("Deps: #404\n", gh, "a/b", main())).toHaveLength(1);
  });

  test("an open issue whose task files are on main passes; absent files are refused", async () => {
    expect(await unmetDeps("Deps: #7 T2\n", gh, "a/b", main(["src/b.ts"]))).toEqual([]);
    expect(await unmetDeps("Deps: #7 T2\n", gh, "a/b", main())).toEqual([
      "Dependency #7 T2 is not merged: the issue is open and its files are not on main.",
    ]);
  });
});

describe("the dependency check at run start", () => {
  const COMMANDS = { read: [], build: ["make *"], verify: ["make *"] };
  const run = async (body: string, others: ReturnType<typeof issue>[]) => {
    const planned = await workflowFor(import.meta.dir, { workflow: "planned-to-pr" });
    const e = engine(
      defaultWorkflow(),
      0,
      {},
      {},
      { routeWorkflows: { "planned-to-pr": planned } },
      {
        config: { agentCommands: COMMANDS },
      },
    );
    e.github.issues.get(1)!.body = body;
    for (const o of others) e.github.issues.set(o.number, o);
    return { e, outcome: await e.run() };
  };
  const planned = async (dep: string) =>
    (await validBody())
      .replace("- `src/engine/failure.ts`", "- `src/engine/failure.ts` (new)")
      .replace("- `src/derive.ts`", "- `src/derive.ts` (new)")
      .replace("Milestone: M1", `Milestone: M1\nDeps: ${dep}`);

  test("an open dependency stops the run before any agent step and names it", async () => {
    const { e, outcome } = await run(await planned("#50"), [issue(50, { state: "OPEN" })]);
    expect(outcome).toBe("needs-human");
    expect(e.executor.mcp).toHaveLength(0);
    expect(
      e.github.issues
        .get(1)!
        .comments.map((c) => c.body)
        .join("\n"),
    ).toContain("Dependency #50 is not merged");
  });

  test("a closed dependency runs on", async () => {
    const { outcome } = await run(await planned("#50"), [issue(50, { state: "CLOSED", stateReason: "COMPLETED" })]);
    expect(outcome).toBe("shipped");
  });
});
