import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BacklogItem, chainReport, sliceBacklog } from "../src/plan-slice";

const item = (id: string, deps: string[], files: string[], minutes: number): BacklogItem => ({
  id,
  deps,
  files,
  minutes,
});

let dir = "";
beforeAll(() => {
  mkdirSync(tmpdir(), { recursive: true });
  dir = mkdtempSync(join(tmpdir(), "plan-slice-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The fixture is read from disk so the test walks a backlog file, not an inline literal.
function fixture(items: BacklogItem[]): BacklogItem[] {
  const file = join(dir, "backlog.json");
  writeFileSync(file, JSON.stringify(items));
  return JSON.parse(readFileSync(file, "utf8")) as BacklogItem[];
}

const chain3 = [
  item("c", ["b"], ["src/c.ts"], 8),
  item("a", [], ["src/a.ts"], 8),
  item("b", ["a"], ["src/b.ts"], 8),
  item("solo", [], ["src/solo.ts"], 10),
];

test("a three-deep chain becomes one epic with ordered tasks", () => {
  const units = sliceBacklog(fixture(chain3));
  expect(units.map((u) => u.id)).toEqual(["a", "solo"]);
  expect(units[0]!.tasks).toEqual(["a", "b", "c"]);
  expect(units[0]!.files).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  expect(units[0]!.minutes).toBe(24);
  expect(units[1]!.tasks).toEqual(["solo"]);
});

test("an over-cap chain splits at a task boundary", () => {
  const items = [item("a", [], ["a"], 20), item("b", ["a"], ["b"], 20), item("c", ["b"], ["c"], 5)];
  const units = sliceBacklog(fixture(items), 30);
  expect(units.map((u) => u.tasks)).toEqual([["a"], ["b", "c"]]);
  expect(units.map((u) => u.minutes)).toEqual([20, 25]);
  expect(units[1]!.after).toBe("a");
});

test("a single task above the cap stays whole", () => {
  const units = sliceBacklog(fixture([item("big", [], ["x"], 90)]), 30);
  expect(units).toEqual([{ id: "big", tasks: ["big"], files: ["x"], minutes: 90 }]);
});

test("the longest chain after slicing the fixture is at most two", () => {
  const items = [...chain3, item("d", ["c"], ["src/d.ts"], 20)];
  const units = sliceBacklog(fixture(items), 30);
  expect(units.map((u) => u.tasks)).toEqual([["a", "b", "c"], ["d"], ["solo"]]);
  const report = chainReport(units);
  expect(report.longestChain).toBe(2);
  expect("warning" in report).toBe(false);
});

test("a chain above two units warns", () => {
  const items = [item("a", [], ["a"], 25), item("b", ["a"], ["b"], 25), item("c", ["b"], ["c"], 25)];
  const report = chainReport(sliceBacklog(fixture(items), 30));
  expect(report).toEqual({ longestChain: 3, warning: "longest dependency chain is 3, above 2" });
});

test("a dependency cycle is refused", () => {
  expect(() => sliceBacklog([item("a", ["b"], [], 1), item("b", ["a"], [], 1)])).toThrow("dependency cycle");
});

const partialFixture = [
  item("a", [], ["src/a.ts", "src/a-api.ts"], 20),
  { ...item("b", [], ["src/b.ts"], 20), partialDeps: [{ dep: "a", files: ["src/a-api.ts"] }] },
];

test("a task needing only an interface of another has chain depth 1, not 2", () => {
  const units = sliceBacklog(fixture(partialFixture), 30);
  expect(units.map((u) => u.id)).toEqual(["a", "b"]);
  expect("after" in units[1]!).toBe(false);
  expect(chainReport(units).longestChain).toBe(1);
});

test("a partial dependency lets the unit start once the interface lands", () => {
  const units = sliceBacklog(fixture(partialFixture), 30);
  expect(units[1]!.startsWhen).toEqual([{ unit: "a", files: ["src/a-api.ts"] }]);
  expect("startsWhen" in units[0]!).toBe(false);
});

test("a full dependency still chains", () => {
  const items = [item("a", [], ["a"], 20), item("b", ["a"], ["b"], 20)];
  const units = sliceBacklog(fixture(items), 30);
  expect(units.map((u) => u.id)).toEqual(["a", "a#2"]);
  expect(units[1]!.after).toBe("a");
  expect("startsWhen" in units[1]!).toBe(false);
  expect(chainReport(units).longestChain).toBe(2);
});
