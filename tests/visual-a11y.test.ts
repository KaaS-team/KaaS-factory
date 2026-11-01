import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { a11yReport, a11yViolations, contrastRatio } from "../src/visual-a11y.js";
import { uiFacts } from "../src/visual.js";

test("contrast ratio matches WCAG reference values", () => {
  expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
  expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  expect(contrastRatio("red", "#fff") === undefined).toBe(true);
});

test("unlabelled input fails, labelled input passes", () => {
  const bad = a11yViolations([{ tag: "input", type: "text", selector: "#q" }]);
  expect(bad).toEqual([{ rule: "label", impact: "critical", selector: "#q", detail: "form field has no label" }]);
  expect(a11yViolations([{ tag: "input", type: "text", label: "Search", selector: "#q" }])).toEqual([]);
});

test("missing alt fails, empty alt passes", () => {
  expect(a11yViolations([{ tag: "img", selector: "img.hero" }]).map((v) => v.rule)).toEqual(["image-alt"]);
  expect(a11yViolations([{ tag: "img", alt: "", selector: "img.hero" }])).toEqual([]);
});

test("low contrast is serious, large text gets the 3:1 floor", () => {
  const el = { tag: "p", foreground: "#777777", background: "#ffffff", selector: "p" };
  expect(a11yViolations([el]).map((v) => [v.rule, v.impact])).toEqual([["color-contrast", "serious"]]);
  expect(a11yViolations([{ ...el, largeText: true }])).toEqual([]);
});

test("report lists each violation", () => {
  expect(a11yReport([])).toBe("No accessibility violations.");
  expect(a11yReport(a11yViolations([{ tag: "input", selector: "#q" }]))).toBe(
    "- critical label #q: form field has no label",
  );
});

test("uiFacts carries a11y violations for a changed route", async () => {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "a11y-"));
  const o = { pr: 1, baseline: dir, current: dir };
  const bad = await uiFacts(["app/page.tsx"], { ...o, elements: [{ tag: "input", selector: "#q" }] });
  expect(bad.a11y?.length).toBe(1);
  const fixed = await uiFacts(["app/page.tsx"], { ...o, elements: [{ tag: "input", label: "Q", selector: "#q" }] });
  expect(fixed.a11y).toEqual([]);
});
