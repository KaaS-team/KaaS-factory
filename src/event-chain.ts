import { createHash } from "node:crypto";

export const GENESIS_PREV_HASH = "0".repeat(64);

export function chainRow(prevHash: string, payload: string): { hash: string; prevHash: string } {
  const hash = createHash("sha256")
    .update(prevHash + "\n" + payload)
    .digest("hex");
  return { hash, prevHash };
}

export function verifyChain(
  rows: { payload: string; prevHash: string; hash: string }[],
): { ok: true } | { ok: false; at: number; reason: "hash" | "link" } {
  let prev = GENESIS_PREV_HASH;
  for (const [at, row] of rows.entries()) {
    if (chainRow(row.prevHash, row.payload).hash !== row.hash) return { ok: false, at, reason: "hash" };
    if (row.prevHash !== prev) return { ok: false, at, reason: "link" };
    prev = row.hash;
  }
  return { ok: true };
}
