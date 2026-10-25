// A deterministic look at a verdict's must/should findings: does each one point at a
// line the diff changed? Unanchored ones are dropped before they can block a merge.
// v2 asked a second `claude -p` the same question over the whole diff (after
// owainlewis/assembler@7cac671, MIT); this answers it without a model call.

import { BLOCKING_CONFIDENCE, type Finding } from "./artifacts";

export interface Rechecker {
  // The indexes (into `findings`) the diff supports, or undefined when the check could not run.
  supported(findings: readonly Finding[], diff: string): Promise<number[] | undefined>;
}

export const isChecked = (f: string | Finding): f is Finding => typeof f !== "string" && f.severity !== "could";

// Findings that survive: could-level and string findings are never re-checked.
export function keepSupported(
  all: readonly (string | Finding)[],
  supported: readonly number[],
): { kept: (string | Finding)[]; dropped: Finding[] } {
  const checked = all.filter(isChecked);
  const keep = new Set(supported.filter((i) => Number.isInteger(i) && i >= 0 && i < checked.length));
  const dropped = checked.filter((_, i) => !keep.has(i));
  return { kept: all.filter((f) => !isChecked(f) || !dropped.includes(f)), dropped };
}

export const hasBlocking = (findings: readonly (string | Finding)[]): boolean =>
  findings.some((f) => isChecked(f) && f.confidence >= BLOCKING_CONFIDENCE);

// The new-side line ranges each file's hunks cover, from `git diff` output.
export function changedLines(diff: string): Map<string, [number, number][]> {
  const files = new Map<string, [number, number][]>();
  let current: [number, number][] | undefined;
  let previous = "";
  for (const line of diff.split("\n")) {
    // A `+++` header always follows `---`; an added line can start with `++` too.
    const file = previous.startsWith("--- ") ? /^\+\+\+ (?:b\/)?(.+)$/.exec(line) : null;
    previous = line;
    if (file) {
      current = file[1] === "/dev/null" ? undefined : [];
      if (current) files.set(file[1]!, current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) current.push([start, start + count - 1]);
    }
  }
  return files;
}

// `path:line` or `path:start-end`, with an optional leading `./`.
function parseWhere(where: string | undefined): { path: string; from: number; to: number } | undefined {
  const m = /^(?:\.\/)?([^\s:]+):(\d+)(?:-(\d+))?\b/.exec(where?.trim() ?? "");
  if (!m) return undefined;
  const from = Number(m[2]);
  return { path: m[1]!, from, to: m[3] === undefined ? from : Number(m[3]) };
}

// Supported means `where` names a file in the diff and a line range that overlaps
// one of its hunks. A finding with no `where`, or one outside every hunk, is dropped.
export class DiffAnchorRechecker implements Rechecker {
  async supported(findings: readonly Finding[], diff: string): Promise<number[]> {
    const lines = changedLines(diff);
    return findings.flatMap((f, i) => {
      const at = parseWhere(f.where);
      const hunks = at && lines.get(at.path);
      return hunks?.some(([a, b]) => at!.from <= b && at!.to >= a) ? [i] : [];
    });
  }
}
