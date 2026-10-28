import { describe, expect, test } from "bun:test";
import { type SchedNode, orderIssues, parseMeta, schedule, topoOrder } from "../src/core/schedule";

const node = (number: number, deps: number[] = [], files: string[] = []): SchedNode => ({
  number,
  deps,
  files,
  runner: "factory",
});
const open = (...ns: number[]) => new Set(ns);

describe("parseMeta", () => {
  test("reads the four keys from the preface only", () => {
    const body = "Deps: #3 #4\nEpic: alpha\nMilestone: M1\nRunner: operator\n\n## Change\nDeps: #9\n";
    const meta = parseMeta(body);
    expect(meta).toEqual({
      deps: [3, 4],
      epic: "alpha",
      milestone: "M1",
      runner: "operator",
      declared: true,
      problems: [],
    });
  });

  test("accepts commas and Deps: none", () => {
    expect(parseMeta("Deps: #3, #4\n").deps).toEqual([3, 4]);
    expect(parseMeta("Deps: none\n")).toMatchObject({ deps: [], declared: true, problems: [] });
  });

  test("an inline Spec line is not metadata", () => {
    const meta = parseMeta("Spec: x · Epic: #82 · Blocked by: #86\n\n## Why\nx\n");
    expect(meta.declared).toBe(false);
    expect(meta.epic).toBeUndefined();
  });

  test("a bad Deps token and a bad Runner are one problem each", () => {
    expect(parseMeta("Deps: foo\n").problems).toEqual(['Deps: "foo" is not #<issue>.']);
    expect(parseMeta("Runner: robot\n").problems).toEqual(['Runner: "robot" is not factory or operator.']);
  });

  test("an empty Epic is a problem", () => {
    expect(parseMeta("Epic:\n").problems).toEqual(["Epic: is empty."]);
  });
});

describe("topoOrder", () => {
  test("puts deps first and keeps input order for independent nodes", () => {
    const r = topoOrder([
      { id: "c", deps: ["a"] },
      { id: "b", deps: [] },
      { id: "a", deps: [] },
    ]);
    expect(r.order).toEqual(["a", "c", "b"]);
    expect(r.cycles).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  test("reports a cycle once and leaves its nodes out of order", () => {
    const r = topoOrder([
      { id: "a", deps: ["b"] },
      { id: "b", deps: ["a"] },
      { id: "c", deps: [] },
    ]);
    expect(r.cycles).toEqual([["a", "b", "a"]]);
    expect(r.order).toEqual(["c"]);
  });

  test("lists a dep that is not a node as missing", () => {
    const r = topoOrder([{ id: "a", deps: ["zz"] }]);
    expect(r.missing).toEqual([{ id: "a", dep: "zz" }]);
  });
});

describe("schedule", () => {
  test("a chain orders deepest first, with the critical path and ready set", () => {
    const s = schedule({
      nodes: [node(1), node(2, [1]), node(3, [2]), node(4)],
      open: open(1, 2, 3, 4),
      slots: 4,
    });
    expect(s.order).toEqual([1, 2, 3, 4]);
    expect(s.criticalPath).toEqual([1, 2, 3]);
    expect(s.ready).toEqual([1, 4]);
    expect(s.why[2]).toBe("#2 waits on #1");
  });

  test("with done given and #1 removed, #2 is ready", () => {
    const s = schedule({
      nodes: [node(2, [1]), node(3, [2])],
      open: open(2, 3),
      done: open(1),
      slots: 2,
    });
    expect(s.ready).toEqual([2]);
    expect(s.missing).toEqual([]);
  });

  test("two ready issues sharing a file are deferred, and disjoint files batch together", () => {
    const shared = schedule({
      nodes: [node(1, [], ["src/a.ts"]), node(2, [], ["src/a.ts"])],
      open: open(1, 2),
      slots: 2,
    });
    expect(shared.batch).toEqual([1]);
    expect(shared.deferred).toEqual([{ issue: 2, sharedWith: 1, files: ["src/a.ts"] }]);
    expect(shared.why[2]).toBe("#2 deferred: shares src/a.ts with #1");

    const disjoint = schedule({
      nodes: [node(1, [], ["src/a.ts"]), node(2, [], ["src/b.ts"])],
      open: open(1, 2),
      slots: 2,
    });
    expect(disjoint.batch).toEqual([1, 2]);
  });

  test("slots caps the batch and the rest wait for a slot", () => {
    const s = schedule({
      nodes: [node(1, [], ["src/a.ts"]), node(2, [], ["src/b.ts"])],
      open: open(1, 2),
      slots: 1,
    });
    expect(s.batch).toEqual([1]);
    expect(s.why[2]).toBe("#2 waits for a slot (1 in use)");
  });

  test("an operator node is never ready or batched, but its dependent waits", () => {
    const s = schedule({
      nodes: [{ ...node(1), runner: "operator" }, node(2, [1])],
      open: open(1, 2),
      slots: 2,
    });
    expect(s.operator).toEqual([1]);
    expect(s.ready).toEqual([]);
    expect(s.batch).toEqual([]);
    expect(s.why[1]).toBe("#1 operator work: needs you");
    expect(s.why[2]).toBe("#2 waits on #1");
  });

  test("a two-node cycle is reported and neither node is ready", () => {
    const s = schedule({
      nodes: [node(3, [4]), node(4, [3])],
      open: open(3, 4),
      slots: 2,
    });
    expect(s.cycles).toEqual([[3, 4, 3]]);
    expect(s.ready).toEqual([]);
    expect(s.why[3]).toBe("#3 on a cycle: #3 -> #4 -> #3");
  });

  test("with done given, a dep outside open and done is missing and blocks", () => {
    const s = schedule({
      nodes: [node(7, [99])],
      open: open(7),
      done: new Set<number>(),
      slots: 1,
    });
    expect(s.missing).toEqual([{ issue: 7, dep: 99 }]);
    expect(s.ready).toEqual([]);
    expect(s.why[7]).toBe("#7 depends on #99, which is not an open or closed issue");
  });
});

describe("review fixes", () => {
  test("a node that is not open is never ready, batched or operator work", () => {
    const s = schedule({
      nodes: [node(1, [], ["src/a.ts"]), { ...node(2), runner: "operator" }],
      open: open(),
      slots: 2,
    });
    expect(s.ready).toEqual([]);
    expect(s.batch).toEqual([]);
    expect(s.operator).toEqual([]);
  });

  test("a repeated dep is listed once", () => {
    expect(parseMeta("Deps: #1 #1\n").deps).toEqual([1]);
  });
});

describe("orderIssues", () => {
  const items = [
    { number: 3, declared: true },
    { number: 4, declared: false },
    { number: 5, declared: true },
  ];
  test("declared items take the plan's order and undeclared items stay put", () => {
    const plan = { order: [5, 3] } as Parameters<typeof orderIssues>[1];
    const out = orderIssues(items, plan, (i) => i.declared);
    expect(out.map((i) => i.number)).toEqual([5, 4, 3]);
  });

  test("with nothing declared, the order is numeric", () => {
    const plan = { order: [] } as unknown as Parameters<typeof orderIssues>[1];
    const out = orderIssues(items, plan, () => false);
    expect(out.map((i) => i.number)).toEqual([3, 4, 5]);
  });
});
