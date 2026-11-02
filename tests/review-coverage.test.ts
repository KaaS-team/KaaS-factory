import { describe, expect, test } from "bun:test";
import { coverage, renderCoverage } from "../src/review-coverage";

const f = (path: string, added: number, deleted = 0, binary?: boolean) => ({ path, added, deleted, binary });

describe("coverage", () => {
  test("empty input reviews nothing and needs no human", () => {
    expect(coverage([])).toEqual({ reviewed: [], skipped: [], needsHuman: false });
  });

  test("a bun.lock change is skipped as generated", () => {
    expect(coverage([f("bun.lock", 3)]).skipped).toEqual([{ path: "bun.lock", reason: "generated" }]);
  });

  test("dist and generated segments and .min. files are generated", () => {
    const c = coverage([f("dist/a.js", 1), f("src/generated/b.ts", 1), f("web/app.min.js", 1), f("src/a.ts", 1)]);
    expect(c.skipped.map((s) => s.reason)).toEqual(["generated", "generated", "generated"]);
    expect(c.reviewed).toEqual(["src/a.ts"]);
  });

  test("a directory named like dist but not equal to it is reviewed", () => {
    expect(coverage([f("distro/a.ts", 1)]).reviewed).toEqual(["distro/a.ts"]);
  });

  test("a binary file is skipped as binary", () => {
    expect(coverage([f("logo.png", 0, 0, true)]).skipped).toEqual([{ path: "logo.png", reason: "binary" }]);
  });

  test("a 900-line file is too_large and its neighbour is reviewed", () => {
    const c = coverage([f("big.ts", 900), f("small.ts", 10)]);
    expect(c.skipped).toEqual([{ path: "big.ts", reason: "too_large" }]);
    expect(c.reviewed).toEqual(["small.ts"]);
  });

  test("the per-file cap holds at 800 and trips at 801, counting added plus deleted", () => {
    expect(coverage([f("a.ts", 500, 300)]).reviewed).toEqual(["a.ts"]);
    expect(coverage([f("a.ts", 500, 301)]).skipped).toEqual([{ path: "a.ts", reason: "too_large" }]);
  });

  test("the total cap holds at 4000 and trips at 4001", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => f(`s${i}.ts`, 100));
    expect(coverage(many(40)).needsHuman).toBe(false);
    expect(coverage([...many(40), f("x.ts", 1)]).needsHuman).toBe(true);
  });

  test("options override the defaults", () => {
    const c = coverage([f("a.ts", 11)], { maxFileLines: 10, maxTotalLines: 5 });
    expect(c.skipped).toEqual([{ path: "a.ts", reason: "too_large" }]);
    expect(c.needsHuman).toBe(true);
  });
});

describe("renderCoverage", () => {
  test("an all-reviewed set renders an empty string", () => {
    expect(renderCoverage(coverage([f("a.ts", 1)]))).toBe("");
  });

  test("skipped paths are listed with their reasons", () => {
    const text = renderCoverage(coverage([f("bun.lock", 1), f("big.ts", 900)]));
    expect(text).toContain("- `bun.lock`: generated");
    expect(text).toContain("- `big.ts`: too_large");
  });

  test("a diff past the total cap says a human should review it", () => {
    const text = renderCoverage({ reviewed: ["a.ts"], skipped: [], needsHuman: true });
    expect(text).toContain("A human should review it.");
  });
});
