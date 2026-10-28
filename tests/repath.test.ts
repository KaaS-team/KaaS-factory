import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repath } from "../scripts/repath";

let root: string;
const put = (rel: string, text: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repath-"));
  put(
    "src/user.ts",
    [
      'import { a } from "./util";',
      'export { a } from "./util";',
      'const lazy = () => import("./util");',
      'import { z } from "./other";',
      'const text = "./util";',
    ].join("\n"),
  );
  put("src/deep/leaf.ts", 'import { a } from "../util.ts";');
  put("src/other.ts", "export const z = 1;");
  put("pkg/util.ts", "export const a = 1;");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (opts = {}) => repath(root, "src/util.ts", "pkg/util.ts", opts).map((f) => f.slice(root.length + 1));

test("static, re-export and dynamic specifiers follow the moved file", () => {
  expect(run().sort()).toEqual(["src/deep/leaf.ts", "src/user.ts"]);
  const user = read("src/user.ts");
  expect(user).toContain('import { a } from "../pkg/util";');
  expect(user).toContain('export { a } from "../pkg/util";');
  expect(user).toContain('import("../pkg/util")');
  expect(read("src/deep/leaf.ts")).toBe('import { a } from "../../pkg/util.ts";');
});

test("a specifier that does not match, and a string that only looks like one, are untouched", () => {
  run();
  const user = read("src/user.ts");
  expect(user).toContain('import { z } from "./other";');
  expect(user).toContain('const text = "./util";');
});

test("a dry run lists the files and writes nothing", () => {
  const before = read("src/user.ts");
  expect(run({ dry: true })).toHaveLength(2);
  expect(read("src/user.ts")).toBe(before);
});

test("a second run changes nothing", () => {
  run();
  expect(run()).toEqual([]);
});

test("a moved directory rewrites paths under it", () => {
  put("src/lib/x.ts", "export const x = 1;");
  put("src/use.ts", 'import { x } from "./lib/x";');
  expect(repath(root, "src/lib", "pkg/lib").map((f) => f.slice(root.length + 1))).toEqual(["src/use.ts"]);
  expect(read("src/use.ts")).toBe('import { x } from "../pkg/lib/x";');
});
