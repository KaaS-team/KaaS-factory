// The qa step kind: the pure render, the injected runner, and the workflow accepting `uses: qa`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDir } from "../src/artifacts";
import { parseWorkflowText } from "../src/engine/workflows";
import { engine, FakeShell, removeEngineDirs } from "./engine-harness";
import { ALL_STEP_TYPES } from "../src/engine/registry";
import { criterionVerdict, qaEnabled, renderQa, runQaStep, type QaRouteResult } from "../src/qa-step";

// A rerun finds the per-run tmpdir removed; the harness mkdtemps inside it.
beforeAll(() => mkdirSync(tmpdir(), { recursive: true }));
afterAll(removeEngineDirs);

const results: QaRouteResult[] = [
  { path: "/", status: 200, ok: true },
  { path: "/bad", status: 500, ok: false },
];
const criteria = [
  { id: "AC1", text: "home loads", routes: ["/"] },
  { id: "AC2", text: "bad loads", routes: ["/", "/bad"] },
  { id: "AC3", text: "no route", routes: [] },
  { id: "AC4", text: "unvisited", routes: ["/gone"] },
];

describe("renderQa", () => {
  const out = renderQa({ routes: ["/", "/bad", "/gone"], run: "bun dev", results, criteria });
  test("lists each route with its result and the run command", () => {
    expect(out).toContain("App started with `bun dev`.");
    expect(out).toContain("| `/` | 200 | pass |");
    expect(out).toContain("| `/bad` | 500 | fail |");
    expect(out).toContain("| `/gone` | none | fail |");
  });
  test("gives pass or fail per acceptance criterion", () => {
    expect(out).toContain("| AC1: home loads | pass |");
    expect(out).toContain("| AC2: bad loads | fail |");
    expect(out).toContain("| AC3: no route | not exercised |");
    expect(out).toContain("| AC4: unvisited | fail |");
  });
  test("no criteria, no criteria table", () => {
    expect(renderQa({ routes: ["/"], run: "x", results })).not.toContain("Acceptance criterion");
  });
  test("verdict is fail when a route failed", () => {
    expect(criterionVerdict(criteria[1]!, results)).toBe("fail");
  });
});

describe("runQaStep", () => {
  const input = { routes: ["/", "/bad"], run: "bun dev" };
  test("not enabled: the runner is never called", async () => {
    let calls = 0;
    const r = await runQaStep(input, async () => (calls++, results), {});
    expect(calls).toBe(0);
    expect(r).toEqual({ ran: false, ok: true });
  });
  test("enabled: the injected runner's results are rendered and a failed route is not ok", async () => {
    const r = await runQaStep(
      input,
      async (run, routes) => (expect(run).toBe("bun dev"), expect(routes).toEqual(["/", "/bad"]), results),
      { FACTORY_QA: "1" },
    );
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.section).toContain("| `/bad` | 500 | fail |");
  });
  test("only FACTORY_QA=1 enables", () => {
    expect(qaEnabled({ FACTORY_QA: "0" })).toBe(false);
    expect(qaEnabled({ FACTORY_QA: "1" })).toBe(true);
  });
});

describe("qa step kind", () => {
  test("is registered, needs a run command, and skips when not enabled", async () => {
    expect(ALL_STEP_TYPES.qa?.command).toBe(true);
    const prev = process.env.FACTORY_QA;
    delete process.env.FACTORY_QA;
    try {
      expect(await ALL_STEP_TYPES.qa!.run({} as never)).toEqual({ kind: "next", facts: { ok: true, skipped: true } });
    } finally {
      if (prev !== undefined) process.env.FACTORY_QA = prev;
    }
  });
});

describe("uses: qa in a workflow", () => {
  const qaFile = (routes: unknown) => JSON.stringify({ routes });
  const wf = () => {
    const parsed = parseWorkflowText(
      "name: qa-flow\nsteps:\n  qa:\n    uses: qa\n    label: factory:qa\n    run: bash .factory/qa.sh\n    next: done\n  done:\n    uses: report\n    label: factory:reporting\n",
    );
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    return parsed.workflow;
  };
  class QaShell extends FakeShell {
    constructor(
      private readonly files: Record<string, string>,
      private readonly exitCode = 0,
    ) {
      super(0);
    }
    override async run(cmd: string, cwd?: string) {
      await super.run(cmd);
      for (const [name, body] of Object.entries(this.files)) {
        mkdirSync(dirname(join(cwd!, name)), { recursive: true });
        writeFileSync(join(cwd!, name), body);
      }
      return { stdout: "", stderr: "", code: this.exitCode };
    }
  }
  const drive = async (enabled: boolean, shell?: QaShell) => {
    const prev = process.env.FACTORY_QA;
    if (enabled) process.env.FACTORY_QA = "1";
    else delete process.env.FACTORY_QA;
    try {
      const e = engine(wf(), 0, {}, {}, shell ? { setupRunner: shell } : {});
      const outcome = await e.run();
      return { e, outcome };
    } finally {
      if (prev === undefined) delete process.env.FACTORY_QA;
      else process.env.FACTORY_QA = prev;
    }
  };
  const qaPath = `${runDir(1)}/qa.json`;

  test("the workflow parses and the engine dispatches the step: skipped when not enabled", async () => {
    const { e, outcome } = await drive(false);
    expect(outcome).toBe("shipped");
    expect(e.setupRunner.ran).not.toContain("bash .factory/qa.sh");
  });
  test("FACTORY_QA=1: the run command executes and the QA table is posted as a stage comment", async () => {
    const shell = new QaShell({ [qaPath]: qaFile([{ path: "/", status: 200, ok: true }]) });
    const { e, outcome } = await drive(true, shell);
    expect(outcome).toBe("shipped");
    expect(shell.ran).toContain("bash .factory/qa.sh");
    expect(
      e.github.issues
        .get(1)!
        .comments.map((c) => c.body)
        .join("\n"),
    ).toContain("| `/` | 200 | pass |");
  });
  test("FACTORY_QA=1: a failed route parks the issue failed with the table, no crash", async () => {
    const shell = new QaShell({ [qaPath]: qaFile([{ path: "/bad", status: 500, ok: false }]) });
    const { e, outcome } = await drive(true, shell);
    expect(outcome).toBe("failed");
    expect(e.github.issues.get(1)!.comments.at(-1)!.body).toContain("| `/bad` | 500 | fail |");
  });
  test("FACTORY_QA=1: a command that exits non-zero fails the step with its reason", async () => {
    const { e, outcome } = await drive(true, new QaShell({}, 3));
    expect(outcome).toBe("failed");
    expect(e.github.issues.get(1)!.comments.at(-1)!.body).toContain("exited 3");
  });
  test("FACTORY_QA=1: no qa.json written is a failure, not a pass", async () => {
    const { outcome } = await drive(true, new QaShell({}));
    expect(outcome).toBe("failed");
  });
});
