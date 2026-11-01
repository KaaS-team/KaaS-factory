// Counts the skipped tests a diff adds, so a self-healing step cannot go green by skipping a test.
import { parseDiff } from "./tamper";

const SKIP = /\b(test|it|describe)\.skip\b|\btest\.fixme\b|\btest\.todo\b|\bxit\(|\bxtest\(|\.skip\(/;
const TEST_FILE = /(\.test\.ts|\.spec\.ts)$|(^|\/)tests\//;

const held = (lines: string[]) => lines.filter((l) => SKIP.test(l)).length;

// Net skips per test file: added lines that hold a skip minus removed lines that held one.
export function skipDeltas(diff: string): { path: string; delta: number }[] {
  return parseDiff(diff)
    .filter((f) => TEST_FILE.test(f.path))
    .map((f) => ({ path: f.path, delta: held(f.added) - held(f.removed) }));
}

export function skipDelta(diff: string): number {
  return skipDeltas(diff).reduce((n, f) => n + f.delta, 0);
}
