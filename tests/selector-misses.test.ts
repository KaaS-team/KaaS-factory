import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { missBody, missTitle, selectorMisses, suggestedInputs } from "../scripts/selector-misses";

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "selector-misses-"));
  for (const [f, t] of [
    ["tests/a.test.ts", 'import { h } from "./helper";\n'],
    ["tests/helper.ts", 'import { s } from "../src/shared";\n'],
    ["src/shared.ts", "export const s = 1;\n"],
  ] as const) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), t);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const entry = { name: "m", file: "src/a.ts", test: "tests/a.test.ts" };

test("a failure whose file is in the diff is not a miss", () => {
  expect(selectorMisses([entry], ["m"], ["src/a.ts"])).toEqual([]);
});

test("a failure reached only through an import is a miss until its inputs line is added", () => {
  const changed = ["src/shared.ts"];
  expect(selectorMisses([entry], ["m"], changed)).toEqual(["m"]);
  const inputs = suggestedInputs(entry.test, changed, root);
  expect(inputs).toEqual(["src/shared.ts"]);
  expect(selectorMisses([{ ...entry, inputs }], ["m"], changed)).toEqual([]);
});

test("the issue names the entry and holds the inputs line", () => {
  expect(missTitle("m")).toBe("Selector miss: m");
  expect(missBody(entry, "abc", ["src/shared.ts"], ["src/shared.ts"])).toContain('"inputs": ["src/shared.ts"]');
});
