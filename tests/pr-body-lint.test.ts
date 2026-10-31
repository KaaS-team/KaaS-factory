import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prBody } from "../src/engine/pr-body";

const template = readFileSync(".github/pull_request_template.md", "utf8");
const body = (verdict: string): string =>
  [
    "Summary: x",
    ...template
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((h) => `${h}\n\n${h.includes("Verify verdict") ? verdict : "Closes #1 evidence 1"}\n`),
  ].join("\n");

describe("prBody lint", () => {
  test("a placeholder verdict throws and names the section, so the open call is never made", () => {
    let opened = 0;
    const open = () => {
      opened++;
      return prBody(body("Pending CI"), { template });
    };
    expect(open).toThrow('section "Verify verdict" is a placeholder');
    expect(opened).toBe(1);
  });
  test("a complete body passes through", () => {
    expect(prBody(body("AC-1 pass"), { template })).toContain("AC-1 pass");
  });
  test("a factory-shaped body is exempt", () => {
    const parts = {
      whatChanged: "## What changed\n\nx",
      acceptance: "## Acceptance\n\n- AC-1",
      runDetails: "#1",
      template,
    };
    expect(prBody("Closes #1", parts)).toContain("run-details comment");
  });
});
