import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agents, steps } from "../src/plugins/registry";
import "../src/agents/presets";
import "../src/engine/registry";

const SRC = join(import.meta.dir, "..", "src");
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [],
  );

// The only files that may import a shipped agent: the presets themselves and the one list that registers them.
const OWN = (f: string) => f.endsWith("/src/agents/presets/index.ts");
const SHIPPED_AGENT_IMPORT = /(?:from|import)\s+"[^"]*(?:agents\/presets\/(?!index)|contrib\/agents\/)/;

describe("core names no shipped agent", () => {
  test("no core file imports a shipped agent module", () => {
    const bad = walk(SRC)
      .filter((f) => !OWN(f))
      .filter((f) => SHIPPED_AGENT_IMPORT.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1));
    expect(bad).toEqual([]);
  });

  test("no core file reads a shipped agent as a property of the registry table", () => {
    const bad = walk(SRC)
      .filter((f) => !OWN(f))
      .filter((f) =>
        /\bPRESETS\.\w+|\bPRESETS\["(?:claude|codex|gemini|opencode|cursor|pi|mastracode|acp)"\]/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => f.slice(SRC.length + 1));
    expect(bad).toEqual([]);
  });

  test("every shipped agent and step type is registered at startup", () => {
    expect(agents.names().sort()).toEqual([
      "acp",
      "claude",
      "codex",
      "cursor",
      "gemini",
      "mastracode",
      "opencode",
      "pi",
    ]);
    for (const s of [
      "triage",
      "plan",
      "build",
      "verify",
      "pr",
      "check",
      "mcp",
      "tool",
      "report",
      "import-plan",
      "qa",
      "changelog",
    ])
      expect(steps.has(s)).toBe(true);
  });
});
