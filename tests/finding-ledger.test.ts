import { describe, expect, test } from "bun:test";
import type { VerdictArtifact } from "../src/artifacts";
import { mergeLedger, openWhats, seedLedger, type LedgerRow } from "../src/finding-ledger";

const must = (what: string, rounds: number): VerdictArtifact => ({
  result: "reject",
  rounds,
  findings: [{ severity: "must", confidence: 5, what }],
});

describe("finding ledger", () => {
  test("a finding from round 1 stays open when round 2 omits it", () => {
    const r1 = must("A", 1);
    const r2 = must("B", 2);
    expect(openWhats(mergeLedger(mergeLedger([], r1), r2))).toEqual(["A", "B"]);
  });

  test("a resolved finding that returns reopens", () => {
    const id = mergeLedger([], must("fix leak", 1))[0]?.id;
    if (!id) throw new Error("expected a row");
    const resolved: LedgerRow = {
      id,
      what: "fix leak",
      status: "resolved",
      firstRound: 1,
      lastRound: 1,
      reopened: 0,
    };
    const row = mergeLedger([resolved], must("fix leak", 2))[0];
    if (!row) throw new Error("expected a row");
    expect(row.status).toBe("open");
    expect(row.reopened).toBe(1);
  });

  test("seeding from an old list", () => {
    expect(openWhats(seedLedger(["x", "y"]))).toEqual(["x", "y"]);
  });
});
