// A change that weakens the tests (only tests touched, a test deleted, an assertion removed, a skip added, a
// matcher loosened) needs a "Test change reason:" line in the PR body. The diff is read with git diff --unified=0.
import { spawnSync } from "node:child_process";

export const KINDS = ["only-tests", "deleted-test", "removed-assertion", "new-skip", "loose-matcher"] as const;
export type Kind = (typeof KINDS)[number];
export interface Finding {
  kind: Kind;
  file: string;
  detail: string;
}
export interface DiffFile {
  path: string;
  deleted: boolean;
  added: string[];
  removed: string[];
}

const ASSERTION = /\b(?:expect|assert)\s*\(|\bassert\.\w+\s*\(/;
const TEST_DECL = /\b(?:test|it)(?:\.\w+)?\s*\(\s*["'\x60]/;
const SKIP = /\b(?:test|it|describe)\.(?:skip|todo|skipIf)\b|@quarantine/;
const LOOSE = /\.(?:toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined)\(\)|expect\.anything\(\)/;
const REASON = /^Test change reason:[ \t]*(\S.{9,})$/m;

const EXT = "(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)";
const TEST_PATH = new RegExp(`(?:^|/)tests?/|\\.(?:test|spec)\\.${EXT}$|_test\\.(?:go|py)$|(?:^|/)test_[^/]*\\.py$`);

// Fixtures, the old mutation list and the per-entry mutation files sit under tests/ but are data, not tests.
const TEST_DATA = /(?:^|\/)fixtures\/|(?:^|\/)tests\/mutations\.json$|(?:^|\/)tests\/mutations\//;

export const isTestFile = (path: string): boolean => TEST_PATH.test(path) && !TEST_DATA.test(path);

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let aPath = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      aPath = m?.[1] ?? "";
      cur = { path: m?.[2] ?? "", deleted: false, added: [], removed: [] };
      files.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("deleted file mode")) {
      cur.deleted = true;
      cur.path = aPath;
    } else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return files;
}

const count = (lines: string[], re: RegExp): number => lines.filter((l) => re.test(l)).length;

export function findings(files: DiffFile[]): Finding[] {
  const out: Finding[] = [];
  if (files.length > 0 && files.every((f) => isTestFile(f.path)))
    out.push({ kind: "only-tests", file: "", detail: "every changed file is a test" });
  for (const f of files.filter((x) => isTestFile(x.path))) {
    const decls = count(f.removed, TEST_DECL) - count(f.added, TEST_DECL);
    if (f.deleted || decls > 0)
      out.push({
        kind: "deleted-test",
        file: f.path,
        detail: f.deleted ? "the file is deleted" : `${decls} fewer test declarations`,
      });
    const asserts = count(f.removed, ASSERTION) - count(f.added, ASSERTION);
    if (asserts > 0) {
      const first = f.removed.find((l) => ASSERTION.test(l))?.trim() ?? "";
      out.push({
        kind: "removed-assertion",
        file: f.path,
        detail: `${asserts} fewer assertions, first removed: ${first}`,
      });
    }
    for (const l of f.added) if (SKIP.test(l)) out.push({ kind: "new-skip", file: f.path, detail: l.trim() });
    for (const l of f.added) if (LOOSE.test(l)) out.push({ kind: "loose-matcher", file: f.path, detail: l.trim() });
  }
  return out;
}

export function problems(diff: string, body: string): string[] {
  const found = findings(parseDiff(diff));
  if (found.length === 0 || REASON.test(body)) return [];
  return [
    ...found.map((f) => `${f.kind}: ${f.file}: ${f.detail}`),
    'state why in a "Test change reason:" line in the PR body',
  ];
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: bun scripts/check-tests-only.ts <base> <head>");
    process.exit(2);
  }
  const git = spawnSync("git", ["diff", "--unified=0", "--no-color", `${base}...${head}`], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (git.status !== 0) {
    console.error(`git diff ${base}...${head}: ${git.stderr.trim()}`);
    process.exit(2);
  }
  const body = process.env.PR_BODY ?? "";
  const found = problems(git.stdout, body);
  if (found.length === 0) {
    const all = findings(parseDiff(git.stdout));
    if (all.length === 0) console.log("check-tests-only: ok");
    else
      console.log(
        `check-tests-only: reason given:\n- ${all.map((f) => `${f.kind}: ${f.file}: ${f.detail}`).join("\n- ")}`,
      );
  } else {
    console.error(`check-tests-only:\n- ${found.join("\n- ")}`);
    process.exit(1);
  }
}
