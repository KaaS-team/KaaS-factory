// The lane a change takes: lite skips the steps a workflow marks `optional: true`, full runs them
// all. A deterministic size and path check, never model output. A protected path, an unknown size
// or a change over either cap is full, and runner.ts asks again before each optional step, so a
// change that grows after triage (or whose build touches a protected path) escalates to full.

import { touchesProtectedPath } from "../boundary";

// A lite change touches at most this many files and changes at most this many lines.
export const LITE_MAX_FILES = 3;
export const LITE_MAX_CHANGED_LINES = 40;

export type Lane = "lite" | "full";
export interface LaneDecision {
  readonly lane: Lane;
  readonly reason: string;
}

// `changedLines` is absent before a build exists: only the file list is known then.
export function chooseLane(
  input: { files: readonly string[]; changedLines?: number },
  protectedPaths: readonly string[],
): LaneDecision {
  const files = [...new Set(input.files)];
  if (files.length === 0) return { lane: "full", reason: "no files named, so the size is unknown" };
  const hits = touchesProtectedPath(files, protectedPaths);
  if (hits.length > 0) return { lane: "full", reason: `touches protected path ${hits[0]}` };
  if (files.length > LITE_MAX_FILES) return { lane: "full", reason: `${files.length} files, over ${LITE_MAX_FILES}` };
  if (input.changedLines !== undefined && input.changedLines > LITE_MAX_CHANGED_LINES)
    return { lane: "full", reason: `${input.changedLines} changed lines, over ${LITE_MAX_CHANGED_LINES}` };
  return { lane: "lite", reason: `${files.length} file(s) and no protected path` };
}
