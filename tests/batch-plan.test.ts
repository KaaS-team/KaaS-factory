import { expect, test } from "bun:test";
import { overlaps, planBatch, specFiles } from "../src/batch-plan";

const spec = (name: string, files: string[], deps?: string[]) => ({ name, files, deps });

test("disjoint specs are both picked", () => {
  const r = planBatch([spec("a", ["src/a.ts"]), spec("b", ["src/b.ts"])], [], 5);
  expect(r.picked).toEqual(["a", "b"]);
  expect(r.skipped).toEqual([]);
});

test("a shared file picks the first and skips the second", () => {
  const r = planBatch([spec("a", ["src/a.ts"]), spec("b", ["./src/a.ts"])], [], 5);
  expect(r.picked).toEqual(["a"]);
  expect(r.skipped).toEqual([{ name: "b", reason: "overlap" }]);
});

test("a spec overlapping an open PR is busy", () => {
  const r = planBatch([spec("a", ["src/a.ts"]), spec("b", ["src/b.ts"])], [["src/a.ts"]], 5);
  expect(r.picked).toEqual(["b"]);
  expect(r.skipped).toEqual([{ name: "a", reason: "busy" }]);
});

test("a spec waits for its deps", () => {
  const specs = [spec("a", ["src/a.ts"], ["x"])];
  expect(planBatch(specs, [], 5).skipped).toEqual([{ name: "a", reason: "deps" }]);
  expect(planBatch(specs, [], 5, ["x"]).picked).toEqual(["a"]);
});

test("the limit is respected", () => {
  const r = planBatch([spec("a", ["a"]), spec("b", ["b"]), spec("c", ["c"])], [], 2);
  expect(r.picked).toEqual(["a", "b"]);
});

test("a directory and a file inside it overlap", () => {
  expect(overlaps(["src/engine"], ["src/engine/steps.ts"])).toBe(true);
  expect(overlaps(["src/engine/steps.ts"], ["src/engine/"])).toBe(true);
  expect(overlaps(["src/engine"], ["src/engineer.ts"])).toBe(false);
});

test("two mutation shards share a folder", () => {
  expect(overlaps(["tests/mutations/a.json"], ["tests/mutations/b.json"])).toBe(true);
});

test("specFiles reads the section and returns empty without one", () => {
  const md = "## Change\nx\n\n## Files\n- `src/a.ts`\n- `tests/a.test.ts`\n\n## Other\n- `no.ts`\n";
  expect(specFiles(md)).toEqual(["src/a.ts", "tests/a.test.ts"]);
  expect(specFiles("## Change\nnothing\n")).toEqual([]);
});
