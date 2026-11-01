// A reviewer that quietly skips generated, binary or oversized files still reports no findings, so
// the PR reads as fully reviewed. This manifest names what was and was not looked at, and flags a
// diff too large to review for a human.

export interface CoverageFile {
  path: string;
  added: number;
  deleted: number;
  binary?: boolean;
}

export type SkipReason = "generated" | "minified" | "binary" | "too_large";

export interface Coverage {
  reviewed: string[];
  skipped: { path: string; reason: SkipReason }[];
  needsHuman: boolean;
}

const LOCKFILES: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "go.sum",
]);
const GENERATED_DIRS: readonly string[] = ["dist", "generated"];

function isGenerated(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (LOCKFILES.has(name) || name.includes(".min.")) return true;
  return parts.slice(0, -1).some((p) => GENERATED_DIRS.includes(p));
}

export function coverage(
  files: CoverageFile[],
  opts: { maxFileLines?: number; maxTotalLines?: number } = {},
): Coverage {
  const maxFile = opts.maxFileLines ?? 800;
  const maxTotal = opts.maxTotalLines ?? 4000;
  const reviewed: string[] = [];
  const skipped: Coverage["skipped"] = [];
  let total = 0;
  for (const f of files) {
    const lines = f.added + f.deleted;
    total += lines;
    if (f.binary) skipped.push({ path: f.path, reason: "binary" });
    else if (isGenerated(f.path)) skipped.push({ path: f.path, reason: "generated" });
    else if (lines > maxFile) skipped.push({ path: f.path, reason: "too_large" });
    else reviewed.push(f.path);
  }
  return { reviewed, skipped, needsHuman: total > maxTotal };
}

export function renderCoverage(c: Coverage): string {
  if (c.skipped.length === 0 && !c.needsHuman) return "";
  const out = ["**Not reviewed**", ""];
  for (const s of c.skipped) out.push(`- \`${s.path}\`: ${s.reason}`);
  if (c.needsHuman) out.push("", "This diff is too large to review automatically. A human should review it.");
  return `${out.join("\n")}\n`;
}
