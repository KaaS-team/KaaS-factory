// The hexagon's import rules, checked on every file rather than in review:
// core is pure, ports name only core and each other, an adapter never reaches
// into another, and the engine reaches adapters only through a port.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

interface Edge {
  readonly file: string; // src-relative importer
  readonly target: string; // src-relative module, or the bare specifier
  readonly typeOnly: boolean;
}

function importsOf(file: string, text: string): Edge[] {
  const out: Edge[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[2] ?? m[3] ?? m[4]!;
    const target = spec.startsWith(".") ? relative(SRC, resolve(dirname(join(SRC, file)), spec)) : spec;
    out.push({ file, target, typeOnly: Boolean(m[1]) });
  }
  return out;
}

function filesUnder(dir: string): string[] {
  return readdirSync(join(SRC, dir), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => relative(SRC, join(d.parentPath, d.name)));
}

const edgesIn = (dir: string) => filesUnder(dir).flatMap((f) => importsOf(f, readFileSync(join(SRC, f), "utf8")));
const layer = (target: string) => target.split("/")[0]!;
const show = (e: Edge) => `${e.file} -> ${e.target}`;

describe("hexagon", () => {
  test("every layer has files, so a rule never passes on an empty directory", () => {
    for (const dir of ["core", "ports", "adapters", "engine"]) expect(filesUnder(dir).length).toBeGreaterThan(0);
  });

  test("core imports nothing outside core, not even node:", () => {
    expect(
      edgesIn("core")
        .filter((e) => layer(e.target) !== "core")
        .map(show),
    ).toEqual([]);
  });

  test("ports import only core and ports, and the config only for its types", () => {
    const bad = edgesIn("ports").filter(
      (e) => !["core", "ports"].includes(layer(e.target)) && !(e.typeOnly && e.target === "config"),
    );
    expect(bad.map(show)).toEqual([]);
  });

  test("an adapter never imports another adapter", () => {
    const bad = edgesIn("adapters").filter(
      (e) => layer(e.target) === "adapters" && e.target.split("/")[1] !== e.file.split("/")[1],
    );
    expect(bad.map(show)).toEqual([]);
  });

  test("the engine reaches adapters only through a port", () => {
    expect(
      edgesIn("engine")
        .filter((e) => layer(e.target) === "adapters")
        .map(show),
    ).toEqual([]);
  });

  test("the import scanner sees every import form", () => {
    const text =
      'import { a } from "../adapters/x/a";\nimport type { B } from "../core/b";\nexport { c } from "./c";\nconst d = await import("../ports/d");\nimport "node:fs";\n';
    expect(importsOf("engine/f.ts", text)).toEqual([
      { file: "engine/f.ts", target: "adapters/x/a", typeOnly: false },
      { file: "engine/f.ts", target: "core/b", typeOnly: true },
      { file: "engine/f.ts", target: "engine/c", typeOnly: false },
      { file: "engine/f.ts", target: "ports/d", typeOnly: false },
      { file: "engine/f.ts", target: "node:fs", typeOnly: false },
    ]);
  });
});
