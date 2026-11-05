// The qa step kind: the pure render, the injected runner, and the workflow accepting `uses: qa`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDir } from "../src/artifacts";
import { parseWorkflowText } from "../src/engine/workflows";
import { engine, FakeShell, removeEngineDirs } from "./engine-harness";
import { ALL_STEP_TYPES } from "../src/engine/registry";
import {
  AppStartError,
  criterionVerdict,
  qaEnabled,
  renderQa,
  runQaStep,
  withRunningApp,
  type AppPorts,
  type QaRouteResult,
} from "../src/qa-step";

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

describe("withRunningApp", () => {
  const spec = { command: "bun dev", url: "http://x", cwd: "/w", timeoutMs: 1000, intervalMs: 100 };
  const harness = (answerAfter: number, exitCode?: number) => {
    let t = 0;
    let probes = 0;
    const log = { stopped: 0, spawned: 0 };
    let resolveExit: (c: number) => void = () => {};
    const exited = new Promise<number>((r) => (resolveExit = r));
    const ports: AppPorts = {
      spawn: () => (
        log.spawned++,
        exitCode !== undefined && resolveExit(exitCode),
        { exited, output: () => "boom: port in use", stop: async () => void log.stopped++ }
      ),
      probe: async () => ++probes > answerAfter,
      sleep: async (ms) => void (t += ms),
      now: () => t,
    };
    return { ports, log };
  };
  test("a start that answers runs the use callback and then stops the app", async () => {
    const { ports, log } = harness(2);
    expect(await withRunningApp(spec, ports, async () => "ok")).toBe("ok");
    expect(log).toEqual({ spawned: 1, stopped: 1 });
  });
  test("a start that exits fails with the command's output and stops the app", async () => {
    const { ports, log } = harness(99, 1);
    const err = await withRunningApp(spec, ports, async () => "no").catch((e) => e);
    expect(err).toBeInstanceOf(AppStartError);
    expect(err.message).toContain("exited 1");
    expect(err.message).toContain("boom: port in use");
    expect(log.stopped).toBe(1);
  });
  test("an app that never answers fails after the timeout with its output and is stopped", async () => {
    const { ports, log } = harness(Number.POSITIVE_INFINITY);
    const err = await withRunningApp(spec, ports, async () => "no").catch((e) => e);
    expect(err).toBeInstanceOf(AppStartError);
    expect(err.message).toContain("did not answer");
    expect(err.message).toContain("boom: port in use");
    expect(log.stopped).toBe(1);
  });
  test("the app is stopped when the use callback throws", async () => {
    const { ports, log } = harness(0);
    await expect(
      withRunningApp(spec, ports, async () => {
        throw new Error("route failed");
      }),
    ).rejects.toThrow("route failed");
    expect(log.stopped).toBe(1);
  });
});

describe("the qa step starts the app", () => {
  test("FACTORY_QA_APP and FACTORY_QA_URL: the app is started, the run command sees no second start, and it is stopped", async () => {
    const prev = { ...process.env };
    process.env.FACTORY_QA = "1";
    process.env.FACTORY_QA_APP = "bun dev";
    process.env.FACTORY_QA_URL = "http://app";
    const log = { spawned: [] as string[], stopped: 0 };
    const appPorts: AppPorts = {
      spawn: (c) => (
        log.spawned.push(c),
        { exited: new Promise<number>(() => {}), output: () => "", stop: async () => void log.stopped++ }
      ),
      probe: async () => true,
      sleep: async () => {},
      now: () => 0,
    };
    try {
      const wfText =
        "name: q\nsteps:\n  qa:\n    uses: qa\n    label: factory:qa\n    run: bash .factory/qa.sh\n    next: done\n  done:\n    uses: report\n    label: factory:reporting\n";
      const parsed = parseWorkflowText(wfText);
      if (!parsed.ok) throw new Error(parsed.problems.join("; "));
      class S extends FakeShell {
        override async run(cmd: string, cwd?: string) {
          await super.run(cmd);
          const f = join(cwd!, runDir(1), "qa.json");
          mkdirSync(dirname(f), { recursive: true });
          writeFileSync(f, JSON.stringify({ routes: [{ path: "/", status: 200, ok: true }] }));
          return { stdout: "", stderr: "", code: 0 };
        }
      }
      const shell = new S(0);
      const e = engine(parsed.workflow, 0, {}, {}, { setupRunner: shell, appPorts } as never);
      expect(await e.run()).toBe("shipped");
      expect(log).toEqual({ spawned: ["bun dev"], stopped: 1 });
      expect(shell.ran.some((c) => c.startsWith('QA_COMMAND=: QA_URL="http://app" bash .factory/qa.sh'))).toBe(true);
    } finally {
      for (const k of ["FACTORY_QA", "FACTORY_QA_APP", "FACTORY_QA_URL"]) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });
});
