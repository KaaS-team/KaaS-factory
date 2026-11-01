// The qa step kind: the pure render, the injected runner, and the workflow accepting `uses: qa`.
import { describe, expect, test } from "bun:test";
import { ALL_STEP_TYPES } from "../src/engine/registry";
import { criterionVerdict, qaEnabled, renderQa, runQaStep, type QaRouteResult } from "../src/qa-step";

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
