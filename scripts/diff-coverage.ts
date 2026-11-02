// Coverage of the lines a change touches. A whole-repo percentage hides a new untested branch inside a
// well covered file, so this reads an lcov file and a diff and counts only changed, executable lines.
//
//   bun scripts/diff-coverage.ts <lcov-file> <base-ref> [--min N]   (default --min 80)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface DiffCoverage {
  covered: number;
  total: number;
  pct: number;
  uncovered: { file: string; line: number }[];
}

const norm = (path: string): string => (path.startsWith("./") ? path.slice(2) : path);

// file -> line -> hit count, from the SF: and DA: records.
export function parseLcov(text: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let cur: Map<number, number> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const name = norm(line.slice(3));
      cur = files.get(name) ?? new Map<number, number>();
      files.set(name, cur);
    } else if (line === "end_of_record") cur = undefined;
    else if (cur && line.startsWith("DA:")) {
      const [no, hits] = line.slice(3).split(",");
      const n = Number(no);
      if (Number.isInteger(n)) cur.set(n, Number(hits) || 0);
    }
  }
  return files;
}

// New-side line numbers per file, from the @@ hunks of a unified diff.
export function changedLines(diff: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let file: string | undefined;
  let next = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      file = p === "/dev/null" ? undefined : norm(p.startsWith("b/") ? p.slice(2) : p);
      if (file && !out.has(file)) out.set(file, []);
    } else if (line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      next = m ? Number(m[1]) : 0;
    } else if (file && line.startsWith("+") && next > 0) out.get(file)?.push(next++);
    else if (file && line.startsWith(" ") && next > 0) next++;
  }
  return out;
}

export function diffCoverage(lcov: Map<string, Map<number, number>>, changed: Map<string, number[]>): DiffCoverage {
  let covered = 0;
  let total = 0;
  const uncovered: { file: string; line: number }[] = [];
  for (const [file, lines] of changed) {
    const record = lcov.get(file);
    if (!record) continue;
    for (const line of lines) {
      const hits = record.get(line);
      if (hits === undefined) continue;
      total++;
      if (hits > 0) covered++;
      else uncovered.push({ file, line });
    }
  }
  return { covered, total, pct: total === 0 ? 100 : (covered / total) * 100, uncovered };
}

function main(argv: string[]): number {
  const args = argv.slice();
  let min = 80;
  const at = args.indexOf("--min");
  if (at >= 0) {
    min = Number(args[at + 1]);
    args.splice(at, 2);
  }
  const [lcovFile, base] = args;
  if (!lcovFile || !base || !Number.isFinite(min)) {
    console.error("usage: bun scripts/diff-coverage.ts <lcov-file> <base-ref> [--min N]");
    return 2;
  }
  const git = spawnSync("git", ["diff", "--unified=0", "--no-color", "--no-ext-diff", base], { encoding: "utf8" });
  if (git.status !== 0) {
    console.error(git.stderr);
    return 2;
  }
  const r = diffCoverage(parseLcov(readFileSync(lcovFile, "utf8")), changedLines(git.stdout));
  console.log(`diff coverage: ${r.pct.toFixed(1)}% (${r.covered}/${r.total} changed executable lines), min ${min}%`);
  for (const u of r.uncovered.slice(0, 20)) console.log(`  uncovered ${u.file}:${u.line}`);
  if (r.uncovered.length > 20) console.log(`  ... ${r.uncovered.length - 20} more`);
  return r.pct < min ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
