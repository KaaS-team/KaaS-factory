// Three traps that cost a rerun each: a bare comment opener in a regex literal stops the security
// scan from parsing the file, asymmetric matchers inside toMatchObject misreport on Bun 1.3, and a
// spawn with no timeout hangs the runner.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..");
const OPENER = `<${"!--"}`;
const ASYMMETRIC = /\bexpect\.(any|anything|stringContaining|stringMatching|objectContaining|arrayContaining)\(/;
const SPAWNS = /(^|\.)(spawnSync|execFileSync)$/;

function parse(file: string, src: string): ts.SourceFile {
  const kind = file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
}

function walk(sf: ts.SourceFile, visit: (n: ts.Node) => void) {
  const go = (n: ts.Node) => {
    visit(n);
    ts.forEachChild(n, go);
  };
  go(sf);
}

const line = (sf: ts.SourceFile, n: ts.Node) =>
  `${sf.fileName}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

export function bareOpeners(file: string, src: string): string[] {
  const sf = parse(file, src);
  const out: string[] = [];
  walk(sf, (n) => {
    if (n.kind === ts.SyntaxKind.RegularExpressionLiteral && n.getText(sf).includes(OPENER)) out.push(line(sf, n));
  });
  return out;
}

export function asymmetricInMatchObject(file: string, src: string): string[] {
  const sf = parse(file, src);
  const out: string[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    if (n.expression.name.text !== "toMatchObject") return;
    if (n.arguments.some((a) => ASYMMETRIC.test(a.getText(sf)))) out.push(line(sf, n));
  });
  return out;
}

export function spawnsWithoutTimeout(file: string, src: string): string[] {
  const sf = parse(file, src);
  const out: string[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n) || !SPAWNS.test(n.expression.getText(sf))) return;
    const opts = n.arguments.find(ts.isObjectLiteralExpression);
    if (!opts?.properties.some((p) => p.name?.getText(sf) === "timeout")) out.push(line(sf, n));
  });
  return out;
}

function tracked(prefixes: string[], exts: RegExp): string[] {
  const out: string[] = [];
  const go = (rel: string) => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "fixtures") go(p);
      } else if (exts.test(e.name)) out.push(p);
    }
  };
  for (const p of prefixes) go(p);
  return out;
}

const scan = (files: string[], check: (f: string, s: string) => string[]) =>
  files.flatMap((f) => check(f, readFileSync(join(ROOT, f), "utf8")));

describe("source traps in the tree", () => {
  test("no regex literal in src, scripts or dashboard has a bare comment opener", () => {
    const files = tracked(["src", "scripts", "dashboard"], /\.(ts|js)$/);
    expect(files.length).toBeGreaterThan(50);
    expect(scan(files, bareOpeners)).toEqual([]);
  });

  test("no test passes an asymmetric matcher inside toMatchObject", () => {
    const files = tracked(["tests"], /\.ts$/).filter((f) => f !== "tests/source-traps.test.ts");
    expect(files.length).toBeGreaterThan(50);
    expect(scan(files, asymmetricInMatchObject)).toEqual([]);
  });

  test("every spawnSync and execFileSync in tests sets a timeout", () => {
    const files = tracked(["tests"], /\.ts$/);
    expect(scan(files, spawnsWithoutTimeout)).toEqual([]);
  });
});

describe("the detectors bite", () => {
  test("a bare opener in a regex literal is found, a class is not, and a string is not", () => {
    expect(bareOpeners("a.ts", `const r = /${OPENER}x/;`).length).toBe(1);
    expect(bareOpeners("a.ts", "const r = /[<]!--x/;")).toEqual([]);
    expect(bareOpeners("a.ts", `const s = "${OPENER}";`)).toEqual([]);
  });

  test("an asymmetric matcher inside toMatchObject is found, one in toEqual is not", () => {
    expect(asymmetricInMatchObject("a.ts", "expect(x).toMatchObject({ a: expect.any(String) });").length).toBe(1);
    expect(
      asymmetricInMatchObject("a.ts", "expect(x).toMatchObject({ a: expect.stringContaining('b') });").length,
    ).toBe(1);
    expect(asymmetricInMatchObject("a.ts", "expect(x).toEqual({ a: expect.any(String) });")).toEqual([]);
    expect(asymmetricInMatchObject("a.ts", "expect(x).toMatchObject({ a: 1 });")).toEqual([]);
  });

  test("a spawn without a timeout is found, one with a timeout is not", () => {
    expect(spawnsWithoutTimeout("a.ts", "Bun.spawnSync(['ls']);").length).toBe(1);
    expect(spawnsWithoutTimeout("a.ts", "Bun.spawnSync(['ls'], { cwd });").length).toBe(1);
    expect(spawnsWithoutTimeout("a.ts", "execFileSync('git', [], { cwd });").length).toBe(1);
    expect(spawnsWithoutTimeout("a.ts", "Bun.spawnSync(['ls'], { timeout: 5 });")).toEqual([]);
    expect(spawnsWithoutTimeout("a.ts", "execFileSync('git', [], { timeout: 5 });")).toEqual([]);
  });
});
