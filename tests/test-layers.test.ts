import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYERS, layerFor } from "../src/test-layers";

const wf = (name: string) => readFileSync(join(import.meta.dir, "..", ".github/workflows", name), "utf8");
const budget = (id: string) => LAYERS.find((l) => l.id === id)?.maxSeconds ?? -1;

describe("test layers", () => {
  test("ids run L0 to L4 with strictly rising budgets", () => {
    expect(LAYERS.map((l) => l.id)).toEqual(["L0", "L1", "L2", "L3", "L4"]);
    for (let i = 1; i < LAYERS.length; i += 1) expect(LAYERS[i]!.maxSeconds).toBeGreaterThan(LAYERS[i - 1]!.maxSeconds);
    expect([budget("L0"), budget("L1"), budget("L2")]).toEqual([10, 60, 180]);
  });

  test("layerFor picks the first budget the time is under", () => {
    expect(layerFor(9)).toBe("L0");
    expect(layerFor(10)).toBe("L1");
    expect(layerFor(5000)).toBe("L4");
  });

  test("the push job's timeout is L3 and the flakes job's is L4", () => {
    const push = /^ {2}push:[\s\S]*?timeout-minutes: (\d+)/m.exec(wf("ci.yml"));
    const flakes = /timeout-minutes: (\d+)/.exec(wf("flakes.yml"));
    expect(Number(push?.[1]) * 60).toBe(budget("L3"));
    expect(Number(flakes?.[1]) * 60).toBe(budget("L4"));
  });

  test("the mutation and flake runs are scheduled", () => {
    expect(wf("mutations.yml")).toMatch(/^\s+schedule:/m);
    expect(wf("flakes.yml")).toMatch(/^\s+schedule:/m);
  });
});
