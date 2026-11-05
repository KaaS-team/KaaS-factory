import { describe, expect, test } from "bun:test";
import { importStatus, importStatuses } from "../src/ports/tracker-status";
import { teamProblems } from "../src/team/schema";

const statuses = { "In Review": "in-review", Blocked: "blocked", Done: "done" };

describe("tracker status import (#609)", () => {
  test("a mapped status becomes its Source state", () => {
    expect(importStatus(statuses, "In Review")).toEqual({ state: "in-review" });
    expect(importStatus(statuses, "Blocked")).toEqual({ state: "blocked" });
  });

  test("an unmapped status is reported by name, not guessed", () => {
    expect(importStatus(statuses, "Waiting on legal")).toEqual({ unmapped: "Waiting on legal" });
    expect(importStatus(undefined, "Done")).toEqual({ unmapped: "Done" });
    // Not a case or inherited-key match.
    expect(importStatus(statuses, "done")).toEqual({ unmapped: "done" });
    expect(importStatus(statuses, "toString")).toEqual({ unmapped: "toString" });
  });

  test("a batch lists each unmapped name once", () => {
    const r = importStatuses(statuses, ["Done", "Odd", "Blocked", "Odd"]);
    expect(r.states).toEqual(["done", undefined, "blocked", undefined]);
    expect(r.unmapped).toEqual(["Odd"]);
  });

  test("a team file rejects a status mapped to something that is not a Source state", () => {
    const team = (s: Record<string, string>) =>
      teamProblems({ name: "t", source: { kind: "jira", statuses: s } }, "team");
    expect(team(statuses)).toEqual([]);
    expect(team({ Open: "started" }).join(" ")).toContain("source.statuses.Open must be one of");
  });
});
