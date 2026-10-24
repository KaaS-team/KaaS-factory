// The edge `if:` language: what it accepts, what it refuses at load, and how a
// missing path reads, since a typo in a workflow must fail at boot.

import { describe, expect, test } from "bun:test";
import { evalExpr, ExprError, parseExpr, rootsOf } from "../src/core/expr";

const run = (src: string, ctx: Record<string, unknown> = {}) => evalExpr(parseExpr(src), ctx);

describe("evalExpr", () => {
  const ctx = { plan: { risk: "low", autoApproveEligible: true, files: 3 }, toggles: { on: true, off: false } };
  test("paths and literals compare strictly", () => {
    expect(run("plan.risk == 'low'", ctx)).toBe(true);
    expect(run('plan.risk != "low"', ctx)).toBe(false);
    expect(run("plan.files == 3", ctx)).toBe(true);
    expect(run("plan.files == '3'", ctx)).toBe(false);
    expect(run("toggles.off == false", ctx)).toBe(true);
    expect(run("plan.missing == null", ctx)).toBe(false);
  });
  test("a path that does not resolve is undefined, so it is falsy", () => {
    expect(run("nope.deeper.still", ctx)).toBeUndefined();
    expect(run("!nope.x", ctx)).toBe(true);
    expect(run("plan.risk.length", ctx)).toBeUndefined();
  });
  test("&& binds tighter than ||, ! tighter than both, parentheses override", () => {
    expect(run("toggles.on || toggles.off && toggles.off", ctx)).toBe(true);
    expect(run("(toggles.on || toggles.off) && toggles.off", ctx)).toBe(false);
    expect(run("!toggles.off && toggles.on", ctx)).toBe(true);
    expect(run("!!toggles.on", ctx)).toBe(true);
  });
  test("escaped quotes in a string literal", () => expect(run("a == 'it\\'s'", { a: "it's" })).toBe(true));
});

describe("parseExpr refuses at load", () => {
  for (const bad of ["", "   ", "a ==", "(a", "a)", "a b", "a = b", "a & b", "a.b(", "1 +", "'open", "a.", "== a"])
    test(JSON.stringify(bad), () => expect(() => parseExpr(bad)).toThrow(ExprError));
});

test("rootsOf names every first path segment, not literals", () => {
  expect(rootsOf(parseExpr("plan.risk == 'low' && !(toggles.x || config.y.z) && true"))).toEqual([
    "plan",
    "toggles",
    "config",
  ]);
});
