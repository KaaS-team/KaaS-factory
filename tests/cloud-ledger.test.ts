import { describe, expect, test } from "bun:test";
import { FactoryState } from "../src/state";
import { cloudLedger } from "../src/cloud/ledger";

describe("cloud ledger", () => {
  test("active counts", () => {
    const state = new FactoryState(":memory:");
    const ledger = cloudLedger(state, "o/r");
    ledger.reserve(7, "cursor-cloud");
    ledger.started(7, "cursor-cloud", "bc-1", "abc123");
    expect(ledger.active()["cursor-cloud"]).toBe(2);
    ledger.settle(7, "finished");
    expect(ledger.active()["cursor-cloud"] ?? 0).toBe(0);
    state.close();
  });

  test("attempt bump", () => {
    const state = new FactoryState(":memory:");
    const ledger = cloudLedger(state, "o/r");
    expect(ledger.reserve(7, "cursor-cloud")).toBe(1);
    ledger.settle(7, "error");
    expect(ledger.reserve(7, "cursor-cloud")).toBe(2);
    state.close();
  });

  test("expire drops stale issue", () => {
    const state = new FactoryState(":memory:");
    const ledger = cloudLedger(state, "o/r");
    ledger.reserve(3, "cursor-cloud");
    const now = Date.now();
    const dropped = ledger.expire(new Set([7]), now, 60_000);
    expect(dropped).toEqual([3]);
    expect(ledger.reservation(3)).toBe(undefined);
    state.close();
  });
});
