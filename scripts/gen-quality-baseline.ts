// quality-baseline/ pins each over-limit file's line count, and the count may only fall.
// This lowers the entries to the files' real sizes so a PR never edits them by hand.
//
//   bun scripts/gen-quality-baseline.ts                 write the lowered baseline in place
//   bun scripts/gen-quality-baseline.ts --check         write nothing; exit 1 if the file is stale
//   bun scripts/gen-quality-baseline.ts --allow-raise   also write entries that would rise
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_DIR, drift, readBaseline, writeBaseline } from "../src/baseline-shards";

export type Sizes = Record<string, number>;

export interface Regenerated {
  readonly next: Sizes;
  readonly raised: string[];
}

export function regenerate(
  current: Sizes,
  measure: (file: string) => number | undefined,
  allowRaise: boolean,
): Regenerated {
  const next: Sizes = {};
  const raised: string[] = [];
  for (const [file, was] of Object.entries(current)) {
    const now = measure(file);
    if (now === undefined) continue;
    if (now > was) raised.push(file);
    next[file] = now <= was || allowRaise ? now : was;
  }
  return { next, raised };
}

const size = (text: string) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const root = value("--root") ?? join(import.meta.dir, "..");
  const dir = value("--baseline") ?? join(root, BASELINE_DIR);
  const baseline = readBaseline(root, dir);
  const was = baseline.metrics.lines ?? {};
  const measure = (file: string) =>
    existsSync(join(root, file)) ? size(readFileSync(join(root, file), "utf8")) : undefined;
  const { next, raised } = regenerate(was, measure, flag("--allow-raise"));
  const wanted = { ...baseline, metrics: { ...baseline.metrics, lines: next } };
  const stale = Object.keys(was).filter((f) => next[f] !== was[f]);
  const dropped = Object.keys(was).filter((f) => !(f in next));
  for (const f of raised)
    console.error(
      `${f}: grew past ${was[f]} (${flag("--allow-raise") ? "raised" : "not raised, fix the file or pass --allow-raise"})`,
    );
  for (const f of stale) console.error(`stale: ${f} ${was[f]} -> ${next[f]}`);
  for (const f of dropped) console.error(`stale: ${f} is gone`);
  const off = drift(wanted, dir);
  if (flag("--check")) {
    for (const rel of off) console.error(`not in canonical form: ${rel}`);
    process.exit(off.length === 0 && raised.length === 0 ? 0 : 1);
  }
  writeBaseline(wanted, dir);
}
