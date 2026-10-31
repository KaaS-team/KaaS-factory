// The healer only proposes locator diffs; this guard refuses anything else.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import { HEAL_FILE, healFindings, healerProblems } from "../src/healer";

const SPEC = "e2e/cart.spec.ts";
const diff = (path: string, removed: string[], added: string[], head = "") =>
  [
    `diff --git a/${path} b/${path}`,
    head,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ]
    .filter((l) => l !== "")
    .join("\n");
const pay = '  await page.getByRole("button", { name: "Pay" }).click();';
const payId = '  await page.getByTestId("pay").click();';

test("a locator-only change has no problems; each other change names its problem", () => {
  expect(healerProblems(diff(SPEC, [pay], [payId]))).toEqual([]);
  expect(healerProblems(diff(SPEC, [pay, "  expect(a).toBe(1);"], [payId, "  expect(a).toBe(2);"]))).toEqual([
    `${SPEC}: the healer changed more than locators`,
  ]);
  const skip = ["test", "skip"].join(".") + '("pays", () => {});';
  expect(healerProblems(diff(SPEC, [], [skip]))).toContain(`${SPEC}: the healer marks a test skipped`);
  const fixme = ["test", "fixme"].join(".") + '("pays", () => {});';
  expect(healerProblems(diff(SPEC, [], [fixme]))).toContain(`${SPEC}: the healer marks a test skipped`);
  expect(healerProblems(diff(SPEC, [pay], [], "deleted file mode 100644"))).toContain(
    `${SPEC}: the healer deleted a spec`,
  );
  expect(healerProblems(diff("src/cart.ts", [pay], [payId]))).toEqual([
    "src/cart.ts: the healer may only edit a Playwright spec",
  ]);
});

test("healFindings reads the run dir's heal.diff and prefixes its problems", () => {
  const wt = mkdtempSync(join(tmpdir(), "heal-"));
  expect(healFindings(wt, 7)).toEqual([]);
  mkdirSync(join(wt, runDir(7)), { recursive: true });
  writeFileSync(join(wt, runDir(7), HEAL_FILE), diff("src/cart.ts", [pay], [payId]));
  expect(healFindings(wt, 7)).toEqual(["heal.diff: src/cart.ts: the healer may only edit a Playwright spec"]);
});

test("the ui-route references are mirrored in the template and state the contract", () => {
  const read = (root: string, stage: string) =>
    readFileSync(`${root}skills/factory-${stage}/references/ui-route.md`, "utf8");
  expect(read(".claude/", "verify")).toBe(read("template/.claude/", "verify"));
  expect(read(".claude/", "verify")).toContain("heal.diff");
  expect(read(".claude/", "build")).toBe(read("template/.claude/", "build"));
  expect(read(".claude/", "build")).toContain("Playwright spec");
});
