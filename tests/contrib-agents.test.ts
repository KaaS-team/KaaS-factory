// Every agent preset lives under contrib/agents and registers itself; the core reaches them only
// through the preset registry in src/agents/presets/index.ts.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PRESETS } from "../src/agents/presets";

const root = join(import.meta.dir, "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

function imports(file: string): string[] {
  const t = new Bun.Transpiler({ loader: "ts" });
  return t.scanImports(readFileSync(file, "utf8")).map((i) => i.path);
}

describe("contrib agents", () => {
  test("every preset lives in contrib/agents, and the core stays in place", () => {
    for (const keep of ["src/state.ts", "src/agents/executor.ts"]) expect(existsSync(join(root, keep))).toBe(true);
    const index = join(root, "src/agents/presets/index.ts");
    const from = Object.fromEntries(
      imports(index)
        .filter((p) => p.startsWith("."))
        .map((p) => [p.split("/").pop()!, relative(root, resolve(join(root, "src/agents/presets"), p))]),
    );
    for (const name of Object.keys(PRESETS)) expect(from[name]).toBe(`contrib/agents/${name}`);
    // Only the registry reaches into contrib: the rest of the core never names a vendor preset.
    const reach = filesUnder(join(root, "src")).filter(
      (f) => f !== index && imports(f).some((p) => p.includes("contrib/")),
    );
    expect(reach.map((f) => relative(root, f))).toEqual([]);
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toMatch(/^COPY contrib \.\/contrib$/m);
  });
});
