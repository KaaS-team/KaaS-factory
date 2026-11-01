// A review finding may carry the reproduction that lets the recheck keep it; the schema checks the
// field and both reviewer instructions ask for it.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateVerdict } from "../src/artifacts";

const verdict = (finding: Record<string, unknown>) => ({
  outcome: "complete",
  result: "reject",
  rounds: 1,
  findings: [{ severity: "must", confidence: 4, what: "w", where: "src/a.ts:1", ...finding }],
});
const REASON = 'a finding\'s "evidence" must be a non-empty string';

test("validateVerdict accepts a finding with evidence or none", () => {
  expect(validateVerdict(verdict({ evidence: "bun test x fails" })).ok).toBe(true);
  expect(validateVerdict(verdict({})).ok).toBe(true);
});

test("validateVerdict refuses empty, blank and non-string evidence", () => {
  for (const evidence of ["", "  ", 3]) {
    const r = validateVerdict(verdict({ evidence }));
    expect(r).toEqual({ ok: false, reason: REASON });
  }
});

test("the reviewer agent and the verify skill describe the evidence field", () => {
  for (const f of ["template/.claude/agents/factory-reviewer.md", "template/.claude/skills/factory-verify/SKILL.md"])
    expect(readFileSync(f, "utf8")).toContain("evidence");
});
