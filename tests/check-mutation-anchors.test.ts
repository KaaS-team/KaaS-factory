import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shardPath, shardText } from "../scripts/mutation-list";
import { anchorProblems, readRepoFile, repoAnchorProblems } from "../scripts/check-mutation-anchors";

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

describe("repoAnchorProblems", () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const repo = (source: string): string => {
    mkdirSync(tmpdir(), { recursive: true });
    const root = mkdtempSync(join(tmpdir(), "anchors-"));
    roots.push(root);
    mkdirSync(join(root, "tests", "mutations"), { recursive: true });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), source);
    return root;
  };
  const shard = {
    name: "Guard holds",
    file: "src/a.ts",
    find: "if (ok)",
    replace: "if (true)",
    test: "tests/a.test.ts",
  };
  const put = (root: string) => writeFileSync(join(root, shardPath(shard.name)), shardText(shard));

  test("a per-entry mutation whose target moved fails by name", () => {
    const root = repo("if (ok) run();\n");
    put(root);
    expect(repoAnchorProblems(root)).toEqual({ problems: [], count: 1 });
    writeFileSync(join(root, "src", "a.ts"), "if (allowed) run();\n");
    expect(repoAnchorProblems(root).problems).toEqual(["Guard holds: find matches 0 times in src/a.ts, expected 1"]);
  });
});
