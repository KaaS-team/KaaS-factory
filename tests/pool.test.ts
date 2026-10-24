// Before pool.ts, pollOnce ran every ready issue's whole five-stage chain
// serially — issue #4 never started until #1 finished (audit finding #2).
// These tests assert the two properties that matter: work actually overlaps
// (bounded concurrency, not one-at-a-time) and every item runs exactly once
// (no double-dispatch, even when concurrency exceeds the item count).

import { describe, expect, test } from "bun:test";
import { runPool } from "../src/pool";

function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("runPool", () => {
  test("every item is processed exactly once, in an arbitrary but complete order", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const seen: number[] = [];
    const results = await runPool(items, 3, async (item) => {
      seen.push(item);
      return item * 10;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
    expect(results).toEqual(items.map((i) => i * 10));
  });

  test("results preserve input order regardless of completion order", async () => {
    const delays = [30, 10, 20];
    const results = await runPool(delays, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(results).toEqual([0, 1, 2]);
  });

  test("runs at most `concurrency` items at once, not one at a time", async () => {
    const items = [1, 2, 3, 4];
    let active = 0;
    let maxActive = 0;
    const gate = defer<void>();

    const run = runPool(items, 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (item === 1)
        await gate.promise; // hold worker 1 open until both slots are busy
      else await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return item;
    });

    // Give both initial workers a chance to start before releasing the gate.
    await new Promise((r) => setTimeout(r, 20));
    expect(maxActive).toBe(2); // never all 4 at once, but more than 1
    gate.resolve();
    await run;
  });

  test("concurrency higher than the item count still runs each item exactly once", async () => {
    const items = ["a", "b"];
    let calls = 0;
    const results = await runPool(items, 10, async (item) => {
      calls += 1;
      return item.toUpperCase();
    });
    expect(calls).toBe(2);
    expect(results).toEqual(["A", "B"]);
  });

  test("an empty item list resolves immediately with no calls", async () => {
    let calls = 0;
    const results = await runPool([], 3, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect(results).toEqual([]);
  });
});
