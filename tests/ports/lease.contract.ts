// What every LeasePort adapter must do. `make` returns a fresh, empty store;
// `peer` (when given) a second handle on the same store, as another worker
// on another machine would have.

import { describe, expect, test } from "bun:test";
import type { LeasePort } from "../../src/ports/lease";

export function leaseContract(name: string, make: () => { port: LeasePort; peer: () => LeasePort }): void {
  describe(`LeasePort contract: ${name}`, () => {
    const T = 30_000;
    test("a free lease is taken, and a live one held by another is not", async () => {
      const { port, peer } = make();
      expect(await port.acquire("7", "a", T, 1_000)).toBe(true);
      expect(await peer().acquire("7", "b", T, 2_000)).toBe(false);
      expect(await peer().acquire("8", "b", T, 2_000)).toBe(true);
    });
    test("the holder renews; once it expires another worker reclaims it", async () => {
      const { port, peer } = make();
      expect(await port.acquire("7", "a", T, 1_000)).toBe(true);
      expect(await port.acquire("7", "a", T, 20_000)).toBe(true);
      expect(await peer().acquire("7", "b", T, 49_999)).toBe(false);
      expect(await peer().acquire("7", "b", T, 50_000)).toBe(true);
      expect(await port.acquire("7", "a", T, 50_001)).toBe(false);
    });
    test("release frees it; a release by a non-holder does nothing", async () => {
      const { port, peer } = make();
      expect(await port.acquire("7", "a", T, 1_000)).toBe(true);
      await peer().release("7", "b");
      expect(await peer().acquire("7", "b", T, 2_000)).toBe(false);
      await port.release("7", "a");
      expect(await peer().acquire("7", "b", T, 3_000)).toBe(true);
    });
    test("racing workers: exactly one wins a free lease, and exactly one an expired one", async () => {
      const { port, peer } = make();
      const race = (at: number) =>
        Promise.all(Array.from({ length: 6 }, (_, i) => (i === 0 ? port : peer()).acquire("9", `w${i}`, T, at)));
      expect((await race(1_000)).filter(Boolean)).toHaveLength(1);
      expect((await race(1_000 + T)).filter(Boolean)).toHaveLength(1);
    });
  });
}
