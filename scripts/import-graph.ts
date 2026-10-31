// An import closure is every file an entry reaches by following imports, with its depth from the entry.
// Only relative imports count: a package is not a file in this repo.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;

export function resolveImport(fromFile: string, spec: string, exists: (p: string) => boolean): string | undefined {
  const p = join(dirname(fromFile), spec).split("\\").join("/");
  if (p.startsWith("..")) return undefined;
  const tries = [p, `${p}.ts`, `${p}.tsx`, `${p}.js`, `${p}/index.ts`];
  if (spec.endsWith(".js")) tries.push(`${p.slice(0, -3)}.ts`);
  return tries.find(exists);
}

export function importsOf(file: string, text: string, exists: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPEC)) {
    const dep = resolveImport(file, m[1]!, exists);
    if (dep !== undefined && !out.includes(dep)) out.push(dep);
  }
  return out;
}

export function importClosure(entry: string, root: string): Map<string, number> {
  const exists = (p: string) => existsSync(join(root, p)) && statSync(join(root, p)).isFile();
  const read = (f: string) => {
    try {
      return readFileSync(join(root, f), "utf8");
    } catch {
      return "";
    }
  };
  const depth = new Map<string, number>([[entry, 0]]);
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const dep of importsOf(file, read(file), exists)) {
      if (depth.has(dep)) continue;
      depth.set(dep, depth.get(file)! + 1);
      queue.push(dep);
    }
  }
  return depth;
}

export function testFiles(root: string): string[] {
  const dir = join(root, "tests");
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f.endsWith(".test.ts") && !f.split("/").includes("fixtures"))
    .map((f) => `tests/${f}`)
    .sort();
}

const closures = new Map<string, Map<string, number>>();

export function coveringTests(file: string, tests: readonly string[], root: string): string[] {
  const depthOf = (t: string) => {
    const key = `${root}\0${t}`;
    const closure = closures.get(key) ?? importClosure(t, root);
    closures.set(key, closure);
    return closure.get(file);
  };
  return tests
    .flatMap((t) => {
      const d = depthOf(t);
      return d === undefined ? [] : [{ t, d }];
    })
    .sort((a, b) => a.d - b.d || a.t.localeCompare(b.t))
    .map((x) => x.t);
}
