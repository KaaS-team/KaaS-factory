import { expect, test } from "bun:test";
import { GENESIS_PREV_HASH, chainRow, verifyChain } from "../src/event-chain";

type Row = { payload: string; prevHash: string; hash: string };

function build(n: number): Row[] {
  const rows: Row[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < n; i++) {
    const payload = `event-${i}`;
    const { hash, prevHash } = chainRow(prev, payload);
    rows.push({ payload, prevHash, hash });
    prev = hash;
  }
  return rows;
}

test("the genesis prevHash is 64 zeros", () => {
  expect(GENESIS_PREV_HASH).toBe("0".repeat(64));
  expect(GENESIS_PREV_HASH.length).toBe(64);
  expect(chainRow(GENESIS_PREV_HASH, "a").prevHash).toBe(GENESIS_PREV_HASH);
});

test("a chain built with chainRow verifies", () => {
  expect(verifyChain(build(5))).toEqual({ ok: true });
});

test("an empty list verifies", () => {
  expect(verifyChain([])).toEqual({ ok: true });
});

test("editing any payload fails at that row with reason hash", () => {
  for (let i = 0; i < 5; i++) {
    const rows = build(5).map((row, at) => (at === i ? { ...row, payload: "tampered" } : row));
    expect(verifyChain(rows)).toEqual({ ok: false, at: i, reason: "hash" });
  }
});

test("deleting a middle row fails at the next row with reason link", () => {
  const rows = build(5);
  rows.splice(2, 1);
  expect(verifyChain(rows)).toEqual({ ok: false, at: 2, reason: "link" });
});

test("deleting the first row fails at the new first row with reason link", () => {
  const rows = build(5);
  rows.shift();
  expect(verifyChain(rows)).toEqual({ ok: false, at: 0, reason: "link" });
});

test("swapping two rows fails", () => {
  const [r0, r1, r2, r3, r4] = build(5);
  const rows = [r0, r2, r1, r3, r4].filter((row): row is Row => row !== undefined);
  expect(verifyChain(rows)).toEqual({ ok: false, at: 1, reason: "link" });
});
