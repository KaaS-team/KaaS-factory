import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inScope, MAX_PR_MUTANTS, prMutants, runMutant, summary } from "../scripts/check-changed-mutants";

let dir = "";
const mutant = {
  file: "src/x.ts",
  line: 1,
  before: "export const big = (n: number) => n >= 10;",
  after: "export const big = (n: number) => n < 10;",
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "changed-mutants-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "src/x.ts"), `${mutant.before}\n`);
  writeFileSync(
    join(dir, "tests/checked.test.ts"),
    'import { expect, test } from "bun:test";\nimport { big } from "../src/x";\ntest("edge", () => {\n  expect(big(10)).toBe(true);\n  expect(big(9)).toBe(false);\n});\n',
  );
  writeFileSync(
    join(dir, "tests/loose.test.ts"),
    'import { expect, test } from "bun:test";\nimport { big } from "../src/x";\ntest("shape", () => {\n  expect(typeof big).toBe("function");\n});\n',
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a checked mutant is killed and an unchecked one survives", async () => {
  expect(await runMutant(dir, mutant, ["tests/checked.test.ts"])).toBe("killed");
  expect(await runMutant(dir, mutant, ["tests/loose.test.ts"])).toBe("survived");
});

test("only source under src, scripts and dashboard is in scope", () => {
  expect(inScope("src/a.ts")).toBe(true);
  for (const f of ["scripts/kaas/x.ts", "tests/a.test.ts", "src/fixtures/a.ts", "src/a.tsx"])
    expect(inScope(f)).toBe(false);
});

const diffOf = (file: string, lines: string[]) =>
  `--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;

test("the mutant count is capped", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i} >= 1;`);
  expect(prMutants(diffOf("src/a.ts", lines), () => lines.join("\n"))).toHaveLength(MAX_PR_MUTANTS);
});

test("a mutant-ok line is skipped and the same line without the comment is kept", () => {
  const waived = "export const e = (a: number, b: number) => a === b; // mutant-ok: equivalent";
  const plain = "export const e = (a: number, b: number) => a === b;";
  expect(prMutants(diffOf("src/a.ts", [waived]), () => waived)).toEqual([]);
  expect(prMutants(diffOf("src/a.ts", [plain]), () => plain)).toHaveLength(1);
});

test("the summary counts each outcome", () => {
  const out = summary([
    { mutant, outcome: "killed", tests: ["a"] },
    { mutant, outcome: "survived", tests: ["b"] },
    { mutant, outcome: "uncovered", tests: [] },
  ]);
  expect(out.split("\n")[0]).toBe("check-changed-mutants: 1 killed, 1 survived, 1 uncovered");
});
