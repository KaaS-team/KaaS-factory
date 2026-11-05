// A mutation names a file's line cap, it never copies the number: the same count in two places breaks the
// unrelated mutation every time the file shrinks (#634).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMutations, type Mutation, pinnedCaps, resolveCaps, shardPath } from "../scripts/mutation-list";
import { readBaseline } from "../src/baseline-shards";

const ROOT = join(import.meta.dir, "..");
const lines = readBaseline(ROOT).metrics.lines ?? {};
const mutation = (find: string, replace: string): Mutation => ({ name: "m", file: "f", find, replace, test: "t" });

test("a cap placeholder resolves to the baseline shard's number, with an optional offset", () => {
  expect(resolveCaps('"max":{{lines:src/a.ts}}', { "src/a.ts": 120 }, "x")).toBe('"max":120');
  expect(resolveCaps("{{lines:src/a.ts+5}}", { "src/a.ts": 120 }, "x")).toBe("125");
  expect(() => resolveCaps("{{lines:src/none.ts}}", { "src/a.ts": 120 }, "x")).toThrow(
    "no line baseline for src/none.ts",
  );
});

test("loadMutations resolves a placeholder from the root's own quality baseline", () => {
  mkdirSync(tmpdir(), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "mutation-pins-"));
  mkdirSync(join(root, "tests", "mutations"), { recursive: true });
  mkdirSync(join(root, "quality-baseline", "lines"), { recursive: true });
  writeFileSync(join(root, "quality-baseline", "lines", "src__a.ts.json"), '{"file":"src/a.ts","max":321}\n');
  const m = { name: "cap", file: "f", find: "{{lines:src/a.ts}}", replace: "{{lines:src/a.ts+9}}", test: "t" };
  writeFileSync(join(root, shardPath(m.name)), JSON.stringify(m));
  expect(loadMutations(root).map((x) => [x.find, x.replace])).toEqual([["321", "330"]]);
});

test("a hard-coded count equal to a line cap is reported, a placeholder or another number is not", () => {
  expect(pinnedCaps(mutation('"max":908', "x"), { "src/cli.ts": 908 })).toEqual(["908"]);
  expect(pinnedCaps(mutation("x", "limit 908 lines"), { "src/cli.ts": 908 })).toEqual(["908"]);
  expect(pinnedCaps(mutation('"max":{{lines:src/cli.ts}}', "x"), { "src/cli.ts": 908 })).toEqual([]);
  expect(pinnedCaps(mutation("9080 v1.908", "x"), { "src/cli.ts": 908 })).toEqual([]);
});

test("no file under tests/mutations pins a count that is also a line cap in quality-baseline", () => {
  const pinned = readdirSync(join(ROOT, "tests", "mutations"))
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const m = JSON.parse(readFileSync(join(ROOT, "tests", "mutations", f), "utf8")) as Mutation;
      return pinnedCaps(m, lines).map((n) => `${f}: ${n}`);
    });
  expect(pinned).toEqual([]);
});

test("the line-baseline mutation names its cap from the shard", () => {
  const raw = readFileSync(join(ROOT, "tests", "mutations", "quality-a-line-baseline-cannot-keep-slack.json"), "utf8");
  expect(raw).toContain("{{lines:src/cli.ts}}");
  const loaded = loadMutations(ROOT).find((m) => m.name === "quality: a line baseline cannot keep slack");
  expect(loaded?.find).toBe(`"max":${lines["src/cli.ts"]}`);
});
