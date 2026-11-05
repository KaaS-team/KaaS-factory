import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shardPath, shardText } from "../scripts/mutation-list";
import { planMustFix } from "../src/engine/plan-critic";
import { pruneList, recordTestTiers, testTiers } from "../src/test-tiers";

const comment = [
  "### Acceptance criteria",
  "- **AC-1:** x: checked by `tests/keep.test.ts`",
  "### Tests to write first",
  "- `tests/keep.test.ts` (permanent)",
  "- `tests/scratch.test.ts` (scaffold)",
  "- `tests/guard.test.ts` (Scaffold)",
  "- `tests/loose.test.ts`",
  "### Risk: low",
].join("\n");

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("each test line is read with its tier, and an untagged one has none", () => {
  expect(testTiers(comment)).toEqual([
    { test: "tests/keep.test.ts", tier: "permanent" },
    { test: "tests/scratch.test.ts", tier: "scaffold" },
    { test: "tests/guard.test.ts", tier: "scaffold" },
    { test: "tests/loose.test.ts" },
  ]);
});

test("the plan check sends back a test with no tier", () => {
  expect(planMustFix(comment, {}, [])).toEqual([
    "Tests to write first: `tests/loose.test.ts` has no tier: end its line with (scaffold) or (permanent).",
  ]);
  expect(planMustFix(comment, { proof: "check" }, [])).toEqual([]);
});

test("the prune list holds scaffold tests no mutation guards", () => {
  expect(pruneList(testTiers(comment), new Set(["tests/guard.test.ts"]))).toEqual(["tests/scratch.test.ts"]);
});

test("a merge records the permanent count and the prune list, and never touches a test file", () => {
  mkdirSync(tmpdir(), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "tiers-"));
  roots.push(root);
  mkdirSync(join(root, "tests", "mutations"), { recursive: true });
  const m = { name: "Guard", file: "src/a.ts", find: "x", replace: "y", test: "tests/guard.test.ts" };
  writeFileSync(join(root, shardPath(m.name)), shardText(m));
  writeFileSync(join(root, "tests", "scratch.test.ts"), "// scaffold\n");
  const record = recordTestTiers(root, join(root, "out", "issue-9.json"), comment);
  expect(record).toEqual({ permanent: 2, scaffold: 2, prune: ["tests/scratch.test.ts"] });
  expect(JSON.parse(readFileSync(join(root, "out", "issue-9.json"), "utf8"))).toEqual(record);
  expect(readFileSync(join(root, "tests", "scratch.test.ts"), "utf8")).toBe("// scaffold\n");
});
