import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { countSuite, junitSeconds, type Ratchet, ratchetProblems } from "../scripts/suite-ratchet";

const base: Ratchet = {
  tests: 10,
  scaffold: 0,
  runtimeSeconds: 100,
  growth: [{ tests: 10, reason: "first count" }],
};

describe("the suite ratchet", () => {
  test("counts test cases and the scaffold-tagged ones", () => {
    const src = [
      'test("a", () => {});',
      "  it('b @" + "scaffold', () => {});",
      "test.concurrent(`c`, () => {});",
      '// test("not one")',
    ].join("\n");
    expect(countSuite([src])).toEqual({ tests: 3, scaffold: 1 });
  });

  test("a suite within every ceiling passes", () => {
    expect(ratchetProblems({ tests: 10, scaffold: 0 }, base, 100)).toEqual([]);
  });

  test("a suite over the test ceiling fails", () => {
    const [p] = ratchetProblems({ tests: 11, scaffold: 0 }, base);
    expect(p).toContain("over the ceiling of 10");
  });

  test("a leftover scaffold-tagged test fails", () => {
    const [p] = ratchetProblems({ tests: 10, scaffold: 1 }, base);
    expect(p).toContain("@scaffold");
  });

  test("a run slower than the ceiling fails", () => {
    const [p] = ratchetProblems({ tests: 10, scaffold: 0 }, base, 101);
    expect(p).toContain("over the ceiling of 100s");
  });

  test("a raised ceiling without a growth reason fails", () => {
    expect(ratchetProblems({ tests: 10, scaffold: 0 }, { ...base, tests: 12 })[0]).toContain("no growth entry");
    expect(ratchetProblems({ tests: 10, scaffold: 0 }, { ...base, growth: [{ tests: 10, reason: " " }] })[0]).toContain(
      "no growth entry",
    );
  });

  test("reads the run time from the junit root", () => {
    expect(junitSeconds('<?xml version="1.0"?><testsuites name="bun test" tests="2" time="12.5">')).toBe(12.5);
    expect(junitSeconds("<testsuites>") === undefined).toBe(true);
  });

  test("the committed ceilings carry a growth reason", () => {
    const committed = JSON.parse(readFileSync("tests/suite-ratchet.json", "utf8")) as Ratchet;
    expect(ratchetProblems({ tests: 0, scaffold: 0 }, committed)).toEqual([]);
  });

  test("make check runs it after the tests", () => {
    const out = Bun.spawnSync(["make", "-n", "check"], { stdout: "pipe", timeout: 20_000 }).stdout.toString();
    expect(out.indexOf("scripts/suite-ratchet.ts")).toBeGreaterThan(out.indexOf("bun test"));
    expect(out).toContain("scripts/suite-ratchet.ts --runtime reports/junit.xml");
  });
});
