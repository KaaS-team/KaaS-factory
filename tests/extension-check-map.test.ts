import { describe, expect, test } from "bun:test";
import { CONCLUSIONS, mapConclusion, pickCheckRun, resolveCheck } from "../src/extension/check-map";

const want = { name: "scan", app: "scanner", head: "abc" };
const run = (over: Record<string, string | undefined>) => ({
  name: "scan",
  appSlug: "scanner",
  headSha: "abc",
  status: "completed",
  conclusion: "success",
  completedAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("mapConclusion", () => {
  const rows: Record<string, [string, string]> = {
    success: ["pass", "continue"],
    neutral: ["neutral", "continue"],
    failure: ["fail", "reject"],
    action_required: ["fail", "park-awaiting-approval"],
    timed_out: ["error", "retry-once"],
    cancelled: ["error", "retry-once"],
    stale: ["error", "retry-once"],
    skipped: ["timeout", "park-needs-human"],
  };
  test("table has exactly the eight rows", () => {
    expect(Object.keys(CONCLUSIONS).sort()).toEqual(Object.keys(rows).sort());
  });
  for (const [conclusion, [status, action]] of Object.entries(rows)) {
    test(`${conclusion} blocking`, () => {
      expect(mapConclusion(conclusion, true)).toEqual({ status, action } as never);
    });
    test(`${conclusion} advisory records`, () => {
      expect(mapConclusion(conclusion, false)).toEqual({ status, action: "record" } as never);
    });
  }
  test("missing or unknown is error / retry-once", () => {
    expect(mapConclusion(undefined, true)).toEqual({ status: "error", action: "retry-once" });
    expect(mapConclusion("bogus", true)).toEqual({ status: "error", action: "retry-once" });
    expect(mapConclusion("toString", true)).toEqual({ status: "error", action: "retry-once" });
  });
});

describe("pickCheckRun", () => {
  test("ignores another app or another sha", () => {
    expect(pickCheckRun([run({ appSlug: "other" })], want) ?? "none").toBe("none");
    expect(pickCheckRun([run({ headSha: "zzz" })], want) ?? "none").toBe("none");
    expect(pickCheckRun([run({ name: "lint" })], want) ?? "none").toBe("none");
  });
  test("ignores runs not completed", () => {
    expect(pickCheckRun([run({ status: "in_progress" })], want) ?? "none").toBe("none");
  });
  test("newest completedAt wins", () => {
    const old = run({ conclusion: "failure", completedAt: "2026-01-01T00:00:00Z" });
    const fresh = run({ conclusion: "success", completedAt: "2026-01-02T00:00:00Z" });
    expect(pickCheckRun([fresh, old], want)?.conclusion).toBe("success");
    expect(pickCheckRun([old, fresh], want)?.conclusion).toBe("success");
  });
});

describe("resolveCheck", () => {
  test("no run and timed out parks", () => {
    expect(resolveCheck([], want, { blocking: true, timedOut: true })).toEqual({
      status: "timeout",
      action: "park-needs-human",
    });
    expect(resolveCheck([], want, { blocking: false, timedOut: true })).toEqual({
      status: "timeout",
      action: "record",
    });
  });
  test("no run and not timed out keeps waiting", () => {
    expect(resolveCheck([], want, { blocking: true, timedOut: false }) ?? "none").toBe("none");
  });
  test("skipped blocking parks, advisory records", () => {
    const runs = [run({ conclusion: "skipped" })];
    expect(resolveCheck(runs, want, { blocking: true, timedOut: false })?.action).toBe("park-needs-human");
    expect(resolveCheck(runs, want, { blocking: false, timedOut: false })?.action).toBe("record");
  });
});
