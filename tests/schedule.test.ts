import { describe, expect, test } from "bun:test";
import { orderIssues, parseMeta, type SchedNode, schedule, topoOrder } from "../src/core/schedule";

const node = (number: number, o: Partial<SchedNode> = {}): SchedNode => ({
  number,
  deps: [],
  files: [],
  runner: "factory",
  ...o,
});

describe("parseMeta", () => {
  test("reads the four keys from the preface only", () => {
    const m = parseMeta("Deps: #3 #4\nEpic: core\nMilestone: M1\nRunner: operator\n\n## Why\nDeps: #9\n");
    expect(m).toMatchObject({ deps: [3, 4], epic: "core", milestone: "M1", runner: "operator", declared: true });
    expect(parseMeta("Deps: #3, #4\n").deps).toEqual([3, 4]);
    expect(parseMeta("Deps: none\n")).toMatchObject({ deps: [], declared: true, problems: [] });
  });
  test("an inline Spec line and a Deps under a heading are not metadata", () => {
    expect(parseMeta("Spec: x · Epic: #82 · Blocked by: #86\n").declared).toBe(false);
    expect(parseMeta("## Change\nDeps: #3\n").declared).toBe(false);
  });
  test("a bad value is one problem", () => {
    expect(parseMeta("Deps: foo\n").problems).toEqual(['Deps: "foo" is not #<issue>.']);
    expect(parseMeta("Runner: robot\n").problems).toEqual(['Runner: "robot" is not factory or operator.']);
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
  });
  test("reports a cycle once and leaves it out", () => {
    const r = topoOrder([
      { id: "a", deps: ["b"] },
      { id: "b", deps: ["a"] },
      { id: "c", deps: [] },
    ]);
    expect(r.cycles).toEqual([["a", "b", "a"]]);
    expect(r.order).toEqual(["c"]);
  });
  test("lists a dep that is not a node as missing", () => {
    expect(topoOrder([{ id: "a", deps: ["z"] }]).missing).toEqual([{ id: "a", dep: "z" }]);
  });
});

describe("schedule", () => {
  const chain = [node(1), node(2, { deps: [1] }), node(3, { deps: [2] }), node(4)];
  test("a chain plus a lone issue orders by depth", () => {
    const s = schedule({ nodes: chain, open: new Set([1, 2, 3, 4]), slots: 4 });
    expect(s.order).toEqual([1, 2, 3, 4]);
    expect(s.criticalPath).toEqual([1, 2, 3]);
    expect(s.ready).toEqual([1, 4]);
    expect(s.why[2]).toBe("#2 waits on #1");
  });
  test("with the head done the next issue is ready", () => {
    const s = schedule({ nodes: chain.slice(1), open: new Set([2, 3, 4]), done: new Set([1]), slots: 4 });
    expect(s.ready).toContain(2);
  });
  test("overlapping picks are deferred, disjoint ones batch", () => {
    const open = new Set([1, 2]);
    const a = schedule({ nodes: [node(1, { files: ["src/a.ts"] }), node(2, { files: ["src/a.ts"] })], open, slots: 2 });
    expect(a.batch).toEqual([1]);
    expect(a.deferred).toEqual([{ issue: 2, sharedWith: 1, files: ["src/a.ts"] }]);
    expect(a.why[2]).toContain("shares src/a.ts with #1");
    const b = schedule({ nodes: [node(1, { files: ["a"] }), node(2, { files: ["b"] })], open, slots: 2 });
    expect(b.batch).toEqual([1, 2]);
  });
  test("slots cap the batch and the rest wait for a slot", () => {
    const s = schedule({ nodes: [node(1), node(2)], open: new Set([1, 2]), slots: 1 });
    expect(s.batch).toEqual([1]);
    expect(s.why[2]).toBe("#2 waits for a slot (1 in use)");
  });
  test("operator work is never ready but its dependent waits", () => {
    const s = schedule({
      nodes: [node(1, { runner: "operator" }), node(2, { deps: [1] })],
      open: new Set([1, 2]),
      slots: 2,
    });
    expect(s.ready).toEqual([]);
    expect(s.operator).toEqual([1]);
    expect(s.why[1]).toBe("#1 operator work: needs you");
    expect(s.why[2]).toBe("#2 waits on #1");
  });
  test("a cycle is reported and neither node is ready", () => {
    const s = schedule({ nodes: [node(3, { deps: [4] }), node(4, { deps: [3] })], open: new Set([3, 4]), slots: 2 });
    expect(s.cycles).toEqual([[3, 4, 3]]);
    expect(s.ready).toEqual([]);
    expect(s.why[3]).toBe("#3 on a cycle: #3 -> #4 -> #3");
  });
  test("with done given, a dep outside open and done is missing", () => {
    const s = schedule({ nodes: [node(7, { deps: [99] })], open: new Set([7]), done: new Set(), slots: 1 });
    expect(s.missing).toEqual([{ issue: 7, dep: 99 }]);
    expect(s.ready).toEqual([]);
  });
});

describe("orderIssues", () => {
  const items = [{ number: 3 }, { number: 4 }, { number: 5 }];
  const plan = (order: number[]) => ({ order }) as Parameters<typeof orderIssues>[1];
  test("undeclared items never move", () => {
    const out = orderIssues(items, plan([5, 3]), (i) => i.number !== 4);
    expect(out.map((i) => i.number)).toEqual([5, 4, 3]);
  });
  test("nothing declared keeps numeric order", () => {
    expect(orderIssues(items, plan([5, 4, 3]), () => false).map((i) => i.number)).toEqual([3, 4, 5]);
  });
});
