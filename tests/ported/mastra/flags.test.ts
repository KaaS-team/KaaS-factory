// Ported from mastra-ai/mastra@68fece5 mastracode/sdk/src/headless/cli.test.ts:49-150,279-310 (Apache-2.0, Copyright (c) 2025 Kepler Software, Inc.). Deviations: vitest becomes bun:test; parseHeadlessArgs lives in cli.ts, which is not ported, so each case asserts through the flag table's own coerce functions; mastraArgv cases are new.

import { describe, expect, it } from "bun:test";
import { FLAGS, buildParseArgsOptions, mastraArgv, renderFlagUsage } from "../../../contrib/agents/mastracode-flags";

const coerce = (key: string, raw: string) => FLAGS.find((f) => f.key === key)!.coerce!(raw);

describe("flag values (parseHeadlessArgs cases)", () => {
  it("validates --output", () => {
    expect(coerce("output", "jsonl")).toBe("jsonl");
    expect(() => coerce("output", "xml")).toThrow(/--output must be one of/);
  });
  it("parses --timeout as a positive integer", () => {
    expect(coerce("timeout", "300")).toBe(300);
    for (const bad of ["0", "1.5", "soon"]) expect(() => coerce("timeout", bad)).toThrow(/--timeout/);
  });
  it("validates --mode", () => {
    expect(coerce("mode", "plan")).toBe("plan");
    expect(() => coerce("mode", "turbo")).toThrow(/--mode/);
  });
  it("validates --thinking-level", () => {
    expect(coerce("thinking-level", "high")).toBe("high");
    expect(() => coerce("thinking-level", "extreme")).toThrow(/--thinking-level/);
  });
  it("parses --max-turns as a positive integer", () => {
    expect(coerce("max-turns", "10")).toBe(10);
    for (const bad of ["0", "1.5", "many"]) expect(() => coerce("max-turns", bad)).toThrow(/--max-turns/);
  });
  it("validates --permission-mode", () => {
    expect(coerce("permission-mode", "auto")).toBe("auto");
    expect(coerce("permission-mode", "deny")).toBe("deny");
    expect(() => coerce("permission-mode", "yolo")).toThrow(/--permission-mode must be/);
  });
});

describe("flag spec", () => {
  it("derives parseArgs options from the flag table", () => {
    const options = buildParseArgsOptions();
    for (const flag of FLAGS) {
      expect(options[flag.key]).toMatchObject({ type: flag.type });
      if (flag.short) expect(options[flag.key]!.short).toBe(flag.short);
    }
    expect(options.continue).toMatchObject({ type: "boolean", default: false });
  });
  it("renders one usage entry per flag, aligned", () => {
    const usage = renderFlagUsage();
    for (const flag of FLAGS) expect(usage).toContain(`--${flag.key}`);
    expect(usage).toMatch(/--permission-mode <mode>\s+How tool approvals/);
  });
  it("reports unknown enum values uniformly", () => {
    expect(() => coerce("mode", "turbo")).toThrow("--mode must be one of: build, plan, fast");
    expect(() => coerce("permission-mode", "nope")).toThrow("--permission-mode must be one of: auto, deny");
  });
});

describe("mastraArgv", () => {
  it("emits validated pairs in table order and rejects bad or unknown flags", () => {
    expect(mastraArgv({ mode: "plan", timeout: "60", output: "jsonl" })).toEqual([
      "--timeout",
      "60",
      "--output",
      "jsonl",
      "--mode",
      "plan",
    ]);
    expect(() => mastraArgv({ timeout: "0" })).toThrow(/--timeout/);
    expect(() => mastraArgv({ bogus: "1" })).toThrow(/unknown Mastra Code flag/);
  });
});
