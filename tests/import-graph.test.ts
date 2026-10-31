import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { coveringTests, importClosure, importsOf, testFiles } from "../scripts/import-graph";

let root = "";
const put = (f: string, text: string) => {
  mkdirSync(dirname(join(root, f)), { recursive: true });
  writeFileSync(join(root, f), text);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "import-graph-"));
  put("src/a.ts", 'import { b } from "./b";\nexport const a = b;\n');
  put("src/b.ts", 'export const b = () => import("./c");\n');
  put("src/c/index.ts", "export const c = 1;\n");
  put("src/d.ts", "export const d = 1;\n");
  put("tests/a.test.ts", 'import { a } from "../src/a";\n');
  put("tests/d.test.ts", 'import { d } from "../src/d.js";\n');
  put("tests/fixtures/x.test.ts", "");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the closure follows relative and dynamic imports with their depth", () => {
  const closure = importClosure("tests/a.test.ts", root);
  expect(closure.get("src/a.ts")).toBe(1);
  expect(closure.get("src/b.ts")).toBe(2);
  expect(closure.get("src/c/index.ts")).toBe(3);
  expect(closure.has("src/d.ts")).toBe(false);
});

test("covering tests are found through the closure, and a .js spec resolves to .ts", () => {
  const tests = testFiles(root);
  expect(coveringTests("src/c/index.ts", tests, root)).toEqual(["tests/a.test.ts"]);
  expect(coveringTests("src/d.ts", tests, root)).toEqual(["tests/d.test.ts"]);
});

test("a spec outside the root is dropped and fixtures are not tests", () => {
  expect(importsOf("src/a.ts", 'import x from "../../out";', () => true)).toEqual([]);
  expect(testFiles(root)).toEqual(["tests/a.test.ts", "tests/d.test.ts"]);
});
