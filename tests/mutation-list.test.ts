import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMutations, type Mutation, mutationSlug, shardPath, shardText } from "../scripts/mutation-list";
import { splitMutations } from "../scripts/split-mutations";

const ROOT = join(import.meta.dir, "..");
const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "mutation-list-"));
  roots.push(d);
  mkdirSync(join(d, "tests", "mutations"), { recursive: true });
  return d;
};
const entry = (name: string): Mutation => ({
  name,
  file: "src/a.ts",
  find: "x",
  replace: "y",
  test: "tests/a.test.ts",
});
const putShard = (root: string, m: Mutation, as = shardPath(m.name)) => writeFileSync(join(root, as), shardText(m));
const putLegacy = (root: string, list: Mutation[]) =>
  writeFileSync(
    join(root, "tests", "mutations.json"),
    `[\n${list.map((m) => `  ${JSON.stringify(m)}`).join(",\n")}\n]\n`,
  );

test("the loader merges the old list and the per-entry files, legacy first", () => {
  const root = tmp();
  putLegacy(root, [entry("Old one")]);
  putShard(root, entry("New B"));
  putShard(root, entry("New A"));
  expect(loadMutations(root).map((m) => m.name)).toEqual(["Old one", "New A", "New B"]);
  expect(loadMutations(join(root, "nowhere"))).toEqual([]);
});

test("the loader rejects a wrong file name, a duplicate name and a malformed entry", () => {
  const root = tmp();
  putShard(root, entry("Right"), "tests/mutations/wrong.json");
  expect(() => loadMutations(root)).toThrow("file name must be");
  const dup = tmp();
  putLegacy(dup, [entry("Same")]);
  putShard(dup, entry("Same"));
  expect(() => loadMutations(dup)).toThrow("listed twice");
  const bad = tmp();
  writeFileSync(join(bad, "tests/mutations/x.json"), JSON.stringify({ name: "x", file: "f", find: "a", replace: "b" }));
  expect(() => loadMutations(bad)).toThrow("not a mutation");
});

test("the slug is unique over the real list, and the repo loads as legacy plus the shards", () => {
  expect(mutationSlug("A: b  -- c!")).toBe("a-b-c");
  const legacy: Mutation[] = JSON.parse(require("node:fs").readFileSync(join(ROOT, "tests/mutations.json"), "utf8"));
  expect(new Set(legacy.map((m) => mutationSlug(m.name))).size).toBe(legacy.length);
  const all = loadMutations(ROOT);
  expect(all.length).toBe(legacy.length + 6);
  expect(all.slice(0, legacy.length)).toEqual(legacy);
});

test("the migration on a copy of the real list round-trips, and a second run fails", () => {
  const root = tmp();
  copyFileSync(join(ROOT, "tests/mutations.json"), join(root, "tests/mutations.json"));
  const real: Mutation[] = JSON.parse(require("node:fs").readFileSync(join(root, "tests/mutations.json"), "utf8"));
  expect(splitMutations(root)).toBe(real.length);
  expect(require("node:fs").existsSync(join(root, "tests/mutations.json"))).toBe(false);
  const byName = (a: Mutation, b: Mutation) => a.name.localeCompare(b.name);
  const strip = (m: Mutation) => ({ name: m.name, file: m.file, find: m.find, replace: m.replace, test: m.test });
  expect(loadMutations(root).sort(byName)).toEqual(real.map(strip).sort(byName));
  expect(() => splitMutations(root)).toThrow();
});

test("two names that share a slug stop the migration before it writes", () => {
  const root = tmp();
  putLegacy(root, [entry("A b"), entry("a-b")]);
  expect(() => splitMutations(root)).toThrow("share the slug");
  expect(require("node:fs").readdirSync(join(root, "tests/mutations"))).toEqual([]);
});
