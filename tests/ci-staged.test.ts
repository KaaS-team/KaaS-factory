// ci/ holds workflow changes a cloud run could not push. The check shows the drift and refuses stale copies (#635).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { problems, readStaged } from "../scripts/check-ci-staged";

const ROOT = join(import.meta.dir, "..");

test("a staged file that differs from its live twin passes", () => {
  expect(problems([{ name: "ci.yml", text: "name: new\n", live: "name: old\n" }])).toEqual([]);
});

test("a staged file with no live twin and no note fails, with the note it passes", () => {
  expect(problems([{ name: "x.yml", text: "name: x\n", live: undefined }])[0]).toContain("no .github/workflows/x.yml");
  expect(problems([{ name: "x.yml", text: "# staged: new\nname: x\n", live: undefined }])).toEqual([]);
});

test("a staged file left behind after it moved live fails", () => {
  expect(problems([{ name: "ci.yml", text: "same\n", live: "same\n" }])[0]).toContain("already moved live");
});

test("readStaged pairs each ci/ file with its live twin", () => {
  mkdirSync(tmpdir(), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "ci-staged-"));
  mkdirSync(join(root, "ci"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "ci", "a.yml"), "staged\n");
  writeFileSync(join(root, "ci", "b.yml"), "only staged\n");
  writeFileSync(join(root, ".github", "workflows", "a.yml"), "live\n");
  expect(readStaged(root)).toEqual([
    { name: "a.yml", text: "staged\n", live: "live\n" },
    { name: "b.yml", text: "only staged\n", live: undefined },
  ]);
});

test("the repo's own staged files pass", () => {
  expect(problems(readStaged(ROOT))).toEqual([]);
});

test("make check runs the staged-workflow check", () => {
  const mk = readFileSync(join(ROOT, "Makefile"), "utf8");
  expect(mk).toMatch(/^check:.*\bcheck-ci-staged\b/m);
  expect(mk).toContain("check-ci-staged:\n\tbun scripts/check-ci-staged.ts");
});
