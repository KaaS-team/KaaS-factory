// Mutants on the changed lines only (spec 10 changed-lines-proven): each line the diff adds to a
// source file gets one mutant, the test command runs against a throwaway copy, and a mutant the
// tests still pass is a line nothing checks. Diff-scoped, so it costs one test run per line.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTestPath } from "./proof";
import { changedLines } from "./recheck";

// The swap is the first operator on the line, so a mutant flips behaviour and never adds code.
const SWAPS: readonly [RegExp, string][] = [
  [/===/, "!=="],
  [/!==/, "==="],
  [/>=/, "<"],
  [/<=/, ">"],
  [/&&/, "||"],
  [/\|\|/, "&&"],
  [/\btrue\b/, "false"],
  [/\bfalse\b/, "true"],
  [/(?<![=!<>])>(?![=>])/, "<="],
  [/(?<![=!<>])<(?![=<])/, ">="],
];

export interface Mutant {
  readonly file: string;
  readonly line: number;
  readonly before: string;
  readonly after: string;
}

const SOURCE = /\.([cm]?[jt]sx?|py|go|rb|rs)$/;

function mutate(text: string): string | undefined {
  if (/^\s*(\/\/|#|\*|import\b)/.test(text)) return undefined;
  let best: { at: number; to: string; re: RegExp } | undefined;
  for (const [re, to] of SWAPS) {
    const m = re.exec(text);
    if (m && (best === undefined || m.index < best.at)) best = { at: m.index, to, re };
  }
  return best && text.replace(best.re, best.to);
}

export function mutantsFor(diff: string, read: (file: string) => string): Mutant[] {
  const out: Mutant[] = [];
  for (const [file, ranges] of changedLines(diff)) {
    if (!SOURCE.test(file) || isTestPath(file)) continue;
    const lines = read(file).split("\n");
    for (const [from, to] of ranges)
      for (let n = from; n <= to; n += 1) {
        const before = lines[n - 1];
        const after = before === undefined ? undefined : mutate(before);
        if (before !== undefined && after !== undefined && after !== before) out.push({ file, line: n, before, after });
      }
  }
  return out;
}

// One test run per mutant, so a wide diff is sampled: the first MAX_MUTANTS lines, in diff order.
export const MAX_MUTANTS = 25;

export interface MutantResult {
  readonly mutants: number;
  readonly survived: readonly string[];
}

// Runs every mutant in one copy of `dir`, restoring each file before the next, and never edits `dir`.
export async function runChangedLineMutants(dir: string, diff: string, testCmd: string): Promise<MutantResult> {
  const mutants = mutantsFor(diff, (f) => readFileSync(join(dir, f), "utf8")).slice(0, MAX_MUTANTS);
  if (!mutants.length) return { mutants: 0, survived: [] };
  const copy = mkdtempSync(join(tmpdir(), "factory-mutants-"));
  const survived: string[] = [];
  try {
    cpSync(dir, copy, { recursive: true, filter: (src) => !src.includes("/.git/") && !src.endsWith("/.git") });
    for (const m of mutants) {
      const path = join(copy, m.file);
      const original = readFileSync(path, "utf8");
      const lines = original.split("\n");
      lines[m.line - 1] = m.after;
      writeFileSync(path, lines.join("\n"));
      const proc = Bun.spawn(["bash", "-c", testCmd], { cwd: copy, stdout: "ignore", stderr: "ignore" });
      if ((await proc.exited) === 0) survived.push(`${m.file}:${m.line}`);
      writeFileSync(path, original);
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  return { mutants: mutants.length, survived };
}
