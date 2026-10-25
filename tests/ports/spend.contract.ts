// What every SpendStore adapter must do. `make` returns a fresh store and a
// way to open another worker's handle on the same shared store.

import { describe, expect, test } from "bun:test";
import type { SpendEntry, SpendStore } from "../../src/ports/spend";

const entry = (issue: number, costUsd: number | null, at = "2026-10-09T08:00:00.000Z"): SpendEntry => ({
  issue,
  stage: "build",
  costUsd,
  tokensIn: 10,
  tokensOut: 5,
  at,
});

export function spendContract(
  name: string,
  make: () => { store: SpendStore; worker: (holder: string) => SpendStore },
): void {
  describe(`SpendStore contract: ${name}`, () => {
    test("an issue's total and the day's total add up what was recorded", async () => {
      const { store } = make();
      await store.record(entry(1, 0.5));
      await store.record(entry(1, 0.25));
      await store.record(entry(2, null));
      expect(await store.issue(1)).toEqual({ costUsd: 0.75, unreportedRuns: 0 });
      expect(await store.issue(2)).toEqual({ costUsd: 0, unreportedRuns: 1 });
      expect(await store.since("2026-10-09T00:00:00.000Z")).toEqual({ costUsd: 0.75, unreportedRuns: 1 });
    });
    test("another day's spend is not today's", async () => {
      const { store } = make();
      await store.record(entry(1, 2, "2026-10-08T23:59:00.000Z"));
      await store.record(entry(1, 1));
      expect((await store.since("2026-10-09T00:00:00.000Z")).costUsd).toBe(1);
      expect((await store.issue(1)).costUsd).toBe(3);
    });
    test("every worker's spend counts, on the issue and for the day", async () => {
      const { store, worker } = make();
      await store.record(entry(1, 1));
      await worker("other").record(entry(1, 2));
      expect((await store.issue(1)).costUsd).toBe(3);
      expect((await worker("third").since("2026-10-09T00:00:00.000Z")).costUsd).toBe(3);
    });
    test("records racing in one worker are all kept", async () => {
      const { store } = make();
      await store.record(entry(1, 0.5));
      await Promise.all([1, 2, 3, 4].map((n) => store.record(entry(n, 0.5))));
      expect((await store.since("2026-10-09T00:00:00.000Z")).costUsd).toBe(2.5);
      expect((await store.issue(1)).costUsd).toBe(1);
    });
  });
}
