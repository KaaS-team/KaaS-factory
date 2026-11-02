import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";

export type RetentionKind = "transcript" | "stream" | "artifact" | "other";
export type RetentionEntry = { path: string; mtimeMs: number; kind: RetentionKind };
export type RetentionDays = Partial<Record<"transcript" | "stream" | "artifact", number>>;

const DAY_MS = 86_400_000;

/** Paths past their retention window. A kind with no configured days, and "other", never expires. */
export function expiredFiles(entries: RetentionEntry[], now: number, days: RetentionDays): string[] {
  return entries
    .filter((e) => {
      if (e.kind === "other") return false;
      const configured = days[e.kind];
      const limit = configured === undefined ? undefined : configured * DAY_MS;
      if (limit === undefined) return false;
      return now - e.mtimeMs > limit;
    })
    .map((e) => e.path);
}

const SEGMENT_KIND: Record<string, RetentionKind> = {
  transcript: "transcript",
  transcripts: "transcript",
  stream: "stream",
  streams: "stream",
  artifact: "artifact",
  artifacts: "artifact",
};

function classify(relative: string): RetentionKind {
  for (const segment of relative.split(sep)) {
    const kind = SEGMENT_KIND[segment];
    if (kind) return kind;
  }
  return "other";
}

function collect(root: string, dir: string, out: RetentionEntry[]): void {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, dirent.name);
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      collect(root, full, out);
      continue;
    }
    if (!dirent.isFile()) continue;
    const relative = full.slice(root.length + 1);
    out.push({ path: full, mtimeMs: lstatSync(full).mtimeMs, kind: classify(relative) });
  }
}

/** Remove files under dir past their window and return the removed paths. Symlinks are skipped, never followed. */
export function sweep(
  dir: string,
  now: number,
  days: RetentionDays,
  remove: (path: string) => void = rmSync,
): string[] {
  const entries: RetentionEntry[] = [];
  collect(dir, dir, entries);
  const expired = expiredFiles(entries, now, days);
  for (const path of expired) remove(path);
  return expired;
}
