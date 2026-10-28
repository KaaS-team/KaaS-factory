// After files move, rewrites relative import specifiers so they resolve to the new place:
// `bun scripts/repath.ts <root> <from> <to> [--dry]`. It moves nothing; the caller moves, then runs this.
// Specifiers are found with the TypeScript parser, so a string that only looks like an import is left alone.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const SOURCE = /\.(ts|tsx|mts|cts)$/;
const SKIP = new Set(["node_modules", ".git"]);

export interface RepathOptions {
  dry?: boolean;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE.test(name)) out.push(full);
  }
  return out;
}

// [start, end) is the specifier text without its quotes.
function specifiers(file: string, text: string): { start: number; end: number; value: string }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: { start: number; end: number; value: string }[] = [];
  const take = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) {
      found.push({ start: node.getStart(sf) + 1, end: node.getEnd() - 1, value: node.text });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) take(node.moduleSpecifier);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) take(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const dropExt = (p: string) => p.replace(SOURCE, "");

// A specifier that names `from` (with or without its extension) or a path under it moves to the same spot under `to`.
function moved(target: string, from: string, to: string): string | undefined {
  for (const [a, b] of [
    [from, to],
    [dropExt(from), dropExt(to)],
  ] as const) {
    if (target === a) return b;
    if (target.startsWith(a + sep)) return b + target.slice(a.length);
  }
  return undefined;
}

export function repath(root: string, from: string, to: string, opts: RepathOptions = {}): string[] {
  const fromAbs = resolve(root, from);
  const toAbs = resolve(root, to);
  const changed: string[] = [];
  for (const file of sourceFiles(resolve(root))) {
    const text = readFileSync(file, "utf8");
    const edits: { start: number; end: number; next: string }[] = [];
    for (const spec of specifiers(file, text)) {
      if (!spec.value.startsWith(".")) continue;
      const target = moved(resolve(dirname(file), spec.value), fromAbs, toAbs);
      if (target === undefined) continue;
      const rel = relative(dirname(file), target).split(sep).join("/");
      edits.push({ start: spec.start, end: spec.end, next: rel.startsWith(".") ? rel : `./${rel}` });
    }
    if (!edits.length) continue;
    let out = text;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.next + out.slice(e.end);
    if (out === text) continue;
    changed.push(file);
    if (!opts.dry) writeFileSync(file, out);
  }
  return changed;
}

if (import.meta.main) {
  const [root, from, to] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!root || !from || !to) {
    console.error("usage: bun scripts/repath.ts <root> <from> <to> [--dry]");
    process.exit(2);
  }
  for (const file of repath(root, from, to, { dry: process.argv.includes("--dry") })) console.log(file);
}
