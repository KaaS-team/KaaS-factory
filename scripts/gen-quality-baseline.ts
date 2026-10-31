// quality-baseline.json pins each over-limit file's line count, and the count may only fall.
// This lowers the entries to the files' real sizes so a PR never edits them by hand.
//
//   bun scripts/gen-quality-baseline.ts                 write the lowered baseline in place
//   bun scripts/gen-quality-baseline.ts --check         write nothing; exit 1 if the file is stale
//   bun scripts/gen-quality-baseline.ts --allow-raise   also write entries that would rise
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  const path = value("--baseline") ?? join(root, "quality-baseline.json");
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  const measure = (file: string) =>
    existsSync(join(root, file)) ? size(readFileSync(join(root, file), "utf8")) : undefined;
  const { next, raised } = regenerate(baseline.lines, measure, flag("--allow-raise"));
  const out = `${JSON.stringify({ ...baseline, lines: next }, null, 2)}\n`;
  const stale = Object.keys(baseline.lines).filter((f) => next[f] !== baseline.lines[f]);
  const dropped = Object.keys(baseline.lines).filter((f) => !(f in next));
  for (const f of raised)
    console.error(
      `${f}: grew past ${baseline.lines[f]} (${flag("--allow-raise") ? "raised" : "not raised, fix the file or pass --allow-raise"})`,
    );
  for (const f of stale) console.error(`stale: ${f} ${baseline.lines[f]} -> ${next[f]}`);
  for (const f of dropped) console.error(`stale: ${f} is gone`);
  if (flag("--check")) {
    process.exit(readFileSync(path, "utf8") === out && raised.length === 0 ? 0 : 1);
  }
  writeFileSync(path, out);
}
