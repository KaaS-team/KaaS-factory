// #590: each agent preset registers itself, and the old core paths do not come back.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const NAMES = ["claude", "codex", "gemini", "opencode", "cursor", "pi", "mastracode", "acp"];

describe("agent presets are plugins", () => {
  test.each(NAMES)("loading contrib/agents/%s alone registers it", (name) => {
    const code = `import { agents } from "./src/plugins/registry"; await import("./contrib/agents/${name}"); console.log(JSON.stringify(agents.names()));`;
    const out = Bun.spawnSync(["bun", "-e", code], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(out.stderr.toString()).toBe("");
    expect(JSON.parse(out.stdout.toString())).toEqual([name]);
  });

  test("the old core paths are gone and the index holds no preset table", () => {
    expect(existsSync(join(root, "src/agents/presets/claude.ts"))).toBe(false);
    expect(existsSync(join(root, "src/agents/presets/acp.ts"))).toBe(false);
    expect(readdirSync(join(root, "src/agents/presets"))).toEqual(["index.ts"]);
    expect(readFileSync(join(root, "src/agents/presets/index.ts"), "utf8")).not.toMatch(/SHIPPED|register\(/);
  });
});
