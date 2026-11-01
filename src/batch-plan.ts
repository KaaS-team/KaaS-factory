// Picks the specs that can launch together: no shared files, none busy in an open PR, deps done.

const SHARD_DIR = "tests/mutations/";

export function specFiles(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^##\s+Files\s*$/.test(l));
  if (start < 0) return [];
  const files: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const m = /^\s*-\s+`([^`]+)`/.exec(line);
    if (m?.[1]) files.push(m[1]);
  }
  return files;
}

const norm = (p: string): string => p.trim().replace(/^\.\//, "").replace(/\/+$/, "");

function pathsOverlap(a: string, b: string): boolean {
  if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
  return a.startsWith(SHARD_DIR) && b.startsWith(SHARD_DIR);
}

export function overlaps(a: string[], b: string[]): boolean {
  const right = b.map(norm);
  return a.map(norm).some((x) => right.some((y) => pathsOverlap(x, y)));
}

export type Skip = { name: string; reason: "deps" | "busy" | "overlap" };

export function planBatch(
  specs: { name: string; files: string[]; deps?: string[] }[],
  busy: string[][],
  limit: number,
  done: string[] = [],
): { picked: string[]; skipped: Skip[] } {
  const picked: string[] = [];
  const skipped: Skip[] = [];
  const taken: string[][] = [];
  for (const spec of specs) {
    if (picked.length >= limit) break;
    if (!(spec.deps ?? []).every((d) => done.includes(d))) {
      skipped.push({ name: spec.name, reason: "deps" });
    } else if (busy.some((files) => overlaps(spec.files, files))) {
      skipped.push({ name: spec.name, reason: "busy" });
    } else if (taken.some((files) => overlaps(spec.files, files))) {
      skipped.push({ name: spec.name, reason: "overlap" });
    } else {
      picked.push(spec.name);
      taken.push(spec.files);
    }
  }
  return { picked, skipped };
}
