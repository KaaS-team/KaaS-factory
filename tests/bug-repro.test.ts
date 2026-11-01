// A bug must reproduce at base: verify rejects a bug whose acceptance rows never failed before the change.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { acceptanceProven, type AcceptanceRow, type AcceptanceVerdict } from "../src/acceptance";
import { bugReproProblem, ownVerdict } from "../src/bug-repro";

const row = (over: Partial<AcceptanceRow>): AcceptanceRow => ({
  spec: "s",
  ac: "AC-1",
  text: "it works",
  holdout: ["t"],
  new: true,
  base: "fail",
  head: "pass",
  ok: true,
  ...over,
});
const verdict = (...acs: AcceptanceRow[]): AcceptanceVerdict => ({ base: "origin/main", acs, errors: [] });
function plan(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "bug-repro-"));
  mkdirSync(join(dir, ".factory/runs/issue-7"), { recursive: true });
  writeFileSync(
    join(dir, ".factory/runs/issue-7/plan.json"),
    JSON.stringify({ criteria: [{ id: "AC-1", text: "x" }], spec: "s" }),
  );
  return dir;
}
const REPRO = "A bug needs at least one acceptance row that fails at base and passes on the branch.";

describe("bug reproduction", () => {
  test("a bug with a row that fails at base and passes at head is reproduced", () => {
    expect(bugReproProblem("bug", verdict(row({})))).toBeUndefined();
  });

  test("a bug whose rows all passed at base is not reproduced", () => {
    expect(bugReproProblem("bug", verdict(row({ base: "pass" })))).toBe(REPRO);
  });

  test("a bug whose only failing-at-base row is not new is not reproduced", () => {
    expect(bugReproProblem("bug", verdict(row({ new: false })))).toBe(REPRO);
  });

  test("a bug with no rows is not reproduced", () => {
    expect(bugReproProblem("bug", verdict())).toBe(REPRO);
  });

  test("a feature needs no reproduction", () => {
    expect(bugReproProblem("feature", verdict(row({ base: "pass" })))).toBeUndefined();
    expect(bugReproProblem(undefined, verdict())).toBeUndefined();
  });

  test("a bug without a reproduction gets the problem as an error, so verify rejects it", () => {
    const v = ownVerdict(verdict(row({ base: "pass" })), plan(), 7, "bug");
    expect(v?.errors).toEqual([REPRO]);
    expect(v && acceptanceProven(v)).toBe(false);
  });

  test("a reproduced bug stays proven", () => {
    const v = ownVerdict(verdict(row({})), plan(), 7, "bug");
    expect(v && acceptanceProven(v)).toBe(true);
  });

  test("a feature with an old row is not held to a reproduction", () => {
    const v = ownVerdict(verdict(row({ base: "pass" })), plan(), 7, "feature");
    expect(v?.errors).toEqual([]);
  });
});
