// Parallel agents never break main: one merge at a time per repo, on a head rebased and re-gated.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirLease, serialMerge } from "../src/merge-queue";

test("one PR merges at a time, and a head the rebase moved waits for its gates", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "queue-")), "locks");
  const merged: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const steps = (head: string, gated = true) => ({
    rebase: async () => head,
    gated: async () => gated,
    merge: async (h: string) => {
      await held;
      merged.push(h);
    },
  });
  // Two runner processes share the lock directory, not memory.
  const first = serialMerge(new DirLease(root), "acme/widgets", "a1", steps("a1"));
  await Bun.sleep(5);
  expect(await serialMerge(new DirLease(root), "acme/widgets", "b1", steps("b1"))).toBe("busy");
  expect(
    await serialMerge(new DirLease(root), "acme/other", "c1", {
      ...steps("c1"),
      merge: async (h) => void merged.push(h),
    }),
  ).toBe("merged");
  release();
  expect(await first).toBe("merged");
  expect(await serialMerge(new DirLease(root), "acme/widgets", "b1", steps("b2"))).toBe("rebased");
  expect(await serialMerge(new DirLease(root), "acme/widgets", "b2", steps("b2", false))).toBe("not-gated");
  expect(await serialMerge(new DirLease(root), "acme/widgets", "b2", steps("b2"))).toBe("merged");
  expect(merged).toEqual(["c1", "a1", "b2"]);
});
