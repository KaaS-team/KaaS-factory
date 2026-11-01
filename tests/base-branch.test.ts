import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBase } from "../src/base-branch";
import { configProblems, loadConfig } from "../src/config";

const config = { base: "main", baseByRoute: { content: "develop", docs: "docs-next" } };

describe("resolveBase", () => {
  test("a mapped route gets its own base", () => {
    expect(resolveBase("content", config)).toBe("develop");
    expect(resolveBase("docs", config)).toBe("docs-next");
  });
  test("an unmapped route, no route, or no map falls back to base", () => {
    expect(resolveBase("bug", config)).toBe("main");
    expect(resolveBase(undefined, config)).toBe("main");
    expect(resolveBase("content", { base: "trunk" })).toBe("trunk");
  });
  test("a route named like an Object prototype key is not mapped", () => {
    expect(resolveBase("toString", config)).toBe("main");
  });
});

describe("baseByRoute in the config file", () => {
  test("loads and validates", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const d = mkdtempSync(join(tmpdir(), "factory-i369-"));
    try {
      mkdirSync(`${d}/.factory`);
      writeFileSync(
        `${d}/.factory/config.json`,
        JSON.stringify({ repo: "o/r", base: "main", baseByRoute: { content: "develop" } }),
      );
      expect((await loadConfig(d)).baseByRoute).toEqual({ content: "develop" });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  test("an empty or non-string branch is refused", () => {
    expect(configProblems({ baseByRoute: { content: "" } })).toEqual([
      'baseByRoute.content: expected a non-empty branch name, got ""',
    ]);
    expect(configProblems({ baseByRoute: { content: 3 } })).toEqual([
      "baseByRoute.content: expected a non-empty branch name, got 3",
    ]);
    expect(configProblems({ baseByRoute: [] })).toEqual(["baseByRoute: expected an object"]);
  });
});
