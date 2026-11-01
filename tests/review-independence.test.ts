import { describe, expect, test } from "bun:test";
import {
  checkIndependence,
  independenceRequired,
  isSensitive,
  parseIndependentPolicy,
  sharedSessions,
} from "../src/review-independence";

const plain = { risk: "low", files: [{ path: "src/a.ts" }] };
const shared = [
  { stage: "build", session_id: "s1" },
  { stage: "verify", session_id: "s1" },
];
const apart = [
  { stage: "build", session_id: "s1" },
  { stage: "verify", session_id: "s2" },
];

describe("policy.review.independent", () => {
  test("an absent policy is manual and a bad one is refused as always", () => {
    expect(parseIndependentPolicy({})).toEqual({ policy: "manual", problems: [] });
    expect(parseIndependentPolicy({ policy: { review: { independent: "when-sensitive" } } }).policy).toBe(
      "when-sensitive",
    );
    const bad = parseIndependentPolicy({ policy: { review: { independent: "sometimes" } } });
    expect(bad.policy).toBe("always");
    expect(bad.problems).toEqual([
      'policy.review.independent: "sometimes" is not one of manual, when-sensitive, always',
    ]);
  });

  test("sensitive means high risk or a path a human always reviews", () => {
    expect(isSensitive(plain)).toBe(false);
    expect(isSensitive({ ...plain, risk: "high" })).toBe(true);
    expect(isSensitive({ files: [{ path: ".github/workflows/ci.yml" }] })).toBe(true);
    expect(isSensitive({ files: [{ path: "docs/x.md" }], extraHumanPaths: ["docs/**"] })).toBe(true);
  });

  test("each policy decides when independence is required", () => {
    expect(independenceRequired("manual", true)).toBe(false);
    expect(independenceRequired("when-sensitive", false)).toBe(false);
    expect(independenceRequired("when-sensitive", true)).toBe(true);
    expect(independenceRequired("always", false)).toBe(true);
  });

  test("only a verify run on a build session counts as shared", () => {
    expect(sharedSessions(shared)).toEqual(["s1"]);
    expect(sharedSessions(apart)).toEqual([]);
    expect(
      sharedSessions([
        { stage: "build", session_id: null },
        { stage: "verify", session_id: null },
      ]),
    ).toEqual([]);
  });

  test("a shared session fails only where the policy requires independence", () => {
    expect(checkIndependence("always", plain, shared)).toEqual({
      required: true,
      ok: false,
      reason: "the verify stage shares the builder's session (s1)",
    });
    expect(checkIndependence("manual", plain, shared)).toEqual({ required: false, ok: true });
    expect(checkIndependence("when-sensitive", plain, shared)).toEqual({ required: false, ok: true });
    expect(checkIndependence("when-sensitive", { ...plain, risk: "high" }, shared).ok).toBe(false);
    expect(checkIndependence("always", plain, apart)).toEqual({ required: true, ok: true });
  });
});
