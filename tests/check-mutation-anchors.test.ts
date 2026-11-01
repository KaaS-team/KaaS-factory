import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anchorProblems, readRepoFile } from "../scripts/check-mutation-anchors";

const files: Record<string, string> = { "a.ts": "one two two" };
const read = (f: string) => files[f];
const entry = (file: string, find: string) => ({ name: "m", file, find });

describe("anchorProblems", () => {
  test("zero matches is a problem naming the entry and count", () => {
    expect(anchorProblems([entry("a.ts", "three")], read)).toEqual(["m: find matches 0 times in a.ts, expected 1"]);
  });

  test("two matches is a problem", () => {
    expect(anchorProblems([entry("a.ts", "two")], read)).toEqual(["m: find matches 2 times in a.ts, expected 1"]);
  });

  test("a missing file is a problem", () => {
    expect(anchorProblems([entry("gone.ts", "one")], read)).toEqual(["m: file gone.ts is missing"]);
  });

  test("an empty find is a problem", () => {
    expect(anchorProblems([entry("a.ts", "")], read)).toEqual(["m: find is empty"]);
  });

  test("one match is clean", () => {
    expect(anchorProblems([entry("a.ts", "one")], read)).toEqual([]);
  });

  test("the real mutations.json anchors all match once", async () => {
    const root = join(import.meta.dir, "..");
    const entries = await Bun.file(join(root, "tests", "mutations.json")).json();
    expect(anchorProblems(entries, readRepoFile(root))).toEqual([]);
  });
});
