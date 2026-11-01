// Typed handoffs: depth and per-run caps, a recorded refusal, and a human ask that is never capped.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capsFrom, decideHandoff, parseHandoff, readLedger, recordHandoff, type Handoff } from "../src/engine/handoff";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function tmp(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const r = mkdtempSync(join(tmpdir(), "factory-handoff-"));
  roots.push(r);
  return r;
}

const caps = { depth: 2, perRun: 3 };
const hop = (depth: number, to = "reviewer"): Handoff => ({
  kind: "agent",
  from: "builder",
  to,
  reason: "needs review",
  depth,
});

describe("decideHandoff", () => {
  test("allows a hop under both caps", () => {
    expect(decideHandoff(hop(1), [], caps).allowed).toBe(true);
  });
  test("refuses a hop at the depth cap and says why", () => {
    const r = decideHandoff(hop(2), [], caps);
    expect(r.allowed).toBe(false);
    expect(r.refusal).toBe("the chain is already 2 hops deep (cap 2).");
  });
  test("refuses once the run cap is spent", () => {
    const ledger = [0, 0, 0].map(() => decideHandoff(hop(0), [], caps));
    const r = decideHandoff(hop(0), ledger, caps);
    expect(r.refusal).toBe("this run already made 3 handoffs (cap 3).");
  });
  test("refused hops do not count toward the run cap", () => {
    const refused = decideHandoff(hop(5), [], caps);
    expect(decideHandoff(hop(0), [refused, refused, refused, refused], caps).allowed).toBe(true);
  });
  test("refuses a hop to itself", () => {
    expect(decideHandoff(hop(0, "builder"), [], caps).refusal).toBe("an agent cannot hand off to itself.");
  });
  test("asking a human is allowed at zero caps", () => {
    const ask: Handoff = { kind: "human", from: "builder", reason: "which API?" };
    expect(decideHandoff(ask, [], { depth: 0, perRun: 0 }).allowed).toBe(true);
  });
});

describe("parseHandoff and capsFrom", () => {
  test("a non-mapping is one sentence, not a throw", () => {
    expect(parseHandoff("x", 0)).toEqual({ ok: false, problem: "a handoff must be a mapping." });
  });
  test("an unknown kind is named", () => {
    const r = parseHandoff({ kind: "robot", from: "a", reason: "r" }, 0);
    expect(r).toEqual({ ok: false, problem: 'handoff.kind must be agent or human, got "robot".' });
  });
  test("a missing reason is refused", () => {
    expect(parseHandoff({ kind: "agent", from: "a", to: "b" }, 0)).toEqual({
      ok: false,
      problem: "handoff.reason is required.",
    });
  });
  test("caps default and read per_run", () => {
    expect(capsFrom(undefined)).toEqual({ depth: 3, perRun: 6 });
    expect(capsFrom({ depth: 1, per_run: 2 })).toEqual({ depth: 1, perRun: 2 });
  });
});

describe("recordHandoff", () => {
  test("writes allowed and refused hops to the run ledger", async () => {
    const cwd = tmp();
    const ok = { kind: "agent", from: "builder", to: "reviewer", reason: "check it" };
    expect((await recordHandoff(cwd, 7, ok, { depth: 3, perRun: 1 })).allowed).toBe(true);
    const second = await recordHandoff(cwd, 7, ok, { depth: 3, perRun: 1 });
    expect(second.allowed).toBe(false);
    const ledger = await readLedger(cwd, 7);
    expect(ledger.map((r) => r.allowed)).toEqual([true, false]);
    expect(ledger[1]?.refusal).toBe("this run already made 1 handoffs (cap 1).");
  });
  test("an unreadable handoff is recorded as refused", async () => {
    const cwd = tmp();
    const r = await recordHandoff(cwd, 8, 42, caps);
    expect(r.allowed).toBe(false);
    expect((await readLedger(cwd, 8)).length).toBe(1);
  });
});
