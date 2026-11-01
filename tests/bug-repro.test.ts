// A bug must reproduce at base: verify rejects a bug whose acceptance rows never failed before the change.

import { describe, expect, test } from "bun:test";
import { acceptanceProven, type AcceptanceRow, type AcceptanceVerdict } from "../src/acceptance";
import { bugReproProblem, withRepro } from "../src/bug-repro";

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
const REPRO = "A bug needs at least one acceptance row that fails at base and passes on the branch.";

describe("bug reproduction", () => {
  test("a bug with a row that fails at base and passes at head is reproduced", () => {
    expect(bugReproProblem("bug", verdict(row({})))).toEqual(undefined);
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
    expect(bugReproProblem("feature", verdict(row({ base: "pass" })))).toEqual(undefined);
    expect(bugReproProblem(undefined, verdict())).toEqual(undefined);
  });

  test("a bug without a reproduction gets the problem as an error, so verify rejects it", () => {
    const v = withRepro(verdict(row({ base: "pass" })), "bug");
    expect(v.errors).toEqual([REPRO]);
    expect(acceptanceProven(v)).toBe(false);
  });

  test("a reproduced bug stays proven", () => {
    expect(acceptanceProven(withRepro(verdict(row({})), "bug"))).toBe(true);
  });

  test("a feature with an old row is not held to a reproduction", () => {
    expect(withRepro(verdict(row({ base: "pass" })), "feature").errors).toEqual([]);
  });
});
