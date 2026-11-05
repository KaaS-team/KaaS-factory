// The quality baseline is a directory of one-line files, so two branches that each add or lower an
// entry touch different paths and git merges them with no conflict:
//   quality-baseline/<metric>/<slug>.json   {"file":"src/cli.ts","max":912}
//   quality-baseline/exclude.json           ["glob", ...]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const BASELINE_DIR = "quality-baseline";
const EXCLUDE = "exclude.json";

export interface Baseline {
  metrics: Record<string, Record<string, number>>;
  exclude: string[];
}

export const shardSlug = (file: string): string => file.replace(/\//g, "__");

// The wanted content of every file in the directory, by path relative to it.
export function render(b: Baseline): Map<string, string> {
  const out = new Map<string, string>();
  for (const [metric, entries] of Object.entries(b.metrics))
    for (const [file, max] of Object.entries(entries))
      out.set(`${metric}/${shardSlug(file)}.json`, `${JSON.stringify({ file, max })}\n`);
  if (b.exclude.length) out.set(EXCLUDE, `${JSON.stringify(b.exclude, null, 2)}\n`);
  return out;
}

function walk(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

export function readBaseline(root: string, dir = join(root, BASELINE_DIR)): Baseline {
  const b: Baseline = { metrics: {}, exclude: [] };
  for (const rel of walk(dir)) {
    const text = readFileSync(join(dir, rel), "utf8");
    if (rel === EXCLUDE) b.exclude = JSON.parse(text);
    else {
      const { file, max } = JSON.parse(text) as { file: string; max: number };
      (b.metrics[rel.split("/")[0]!] ??= {})[file] = max;
    }
  }
  return b;
}

// Paths that differ from what `render` wants: missing, changed or left over.
export function drift(b: Baseline, dir: string): string[] {
  const want = render(b);
  const have = new Set(walk(dir));
  const bad = [...want].filter(([rel, text]) => !have.has(rel) || readFileSync(join(dir, rel), "utf8") !== text);
  return [...bad.map(([rel]) => rel), ...[...have].filter((rel) => !want.has(rel))].sort();
}

export function writeBaseline(b: Baseline, dir: string): void {
  const want = render(b);
  for (const rel of walk(dir)) if (!want.has(rel)) rmSync(join(dir, rel));
  for (const [rel, text] of want) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}
