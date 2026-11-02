import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { commentProblems } from "../src/comment-voice";
import { customerView, renderStakeholder } from "../src/summary/render";
import type { SummaryV1 } from "../src/summary/types";

function fixture(over: Partial<SummaryV1> = {}): SummaryV1 {
  return {
    apiVersion: "factory.summary/v1",
    oneLine: "The change shipped as planned.",
    outcome: "pass",
    planVsReality: [
      { row: "files", planned: "Touch the parser", actual: "Touched the parser", status: "met" },
      { row: "review", planned: "One review round", actual: null, status: "not-recorded" },
    ],
    deviations: ["Added a helper file"],
    notProven: [],
    ...over,
  };
}

test("free text loses a model id, an amount and a run id", () => {
  const s = fixture({
    oneLine: "Built with claude-sonnet-5-5 for $12.50 in run-abc123def.",
    deviations: ["Switched to claude-opus-5-5 at 3 USD"],
    planVsReality: [
      {
        row: "files",
        planned: "Use gpt-5 here",
        actual: "Spent $4 on run-zzzz9999",
        status: "deviation",
        detail: "Ran on build-host-01.internal with sonnet 5.5",
      },
    ],
  });
  const out = JSON.stringify(customerView(s));
  for (const bad of [
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "gpt-5",
    "$12.50",
    "$4",
    "3 USD",
    "run-abc123def",
    "run-zzzz9999",
    "sonnet 5.5",
  ]) {
    expect(out.includes(bad)).toBe(false);
  }
  expect(out.includes("[removed]")).toBe(true);
});

test("the customer view never has an operator key", () => {
  const s = fixture({ operator: { costUsd: 3, models: ["claude-sonnet-5-5"] } });
  expect(Object.keys(customerView(s)).includes("operator")).toBe(false);
});

test("the stakeholder render passes the comment voice check", () => {
  expect(commentProblems(renderStakeholder(customerView(fixture())))).toEqual([]);
});

test("a not-recorded row reads as text, never zero", () => {
  const md = renderStakeholder(customerView(fixture()));
  expect(md.includes("| One review round | not recorded | not recorded |")).toBe(true);
  expect(md.includes("| 0 ")).toBe(false);
  expect(md.includes("Deviations")).toBe(true);
});

test("the renderer source names no operator fields", () => {
  const src = readFileSync(new URL("../src/summary/render.ts", import.meta.url), "utf8");
  for (const word of ["costUsd", "tokens", "runtime"]) expect(src.includes(word)).toBe(false);
});
