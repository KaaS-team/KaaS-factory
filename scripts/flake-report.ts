// Nightly flake report: bun test --rerun-each 3 writes one testcase per run, so a test that both passed and failed
// in one report flipped. Flips are counted in a history file; a test at FLAKE_LIMIT must be quarantined by hand
// (scripts/quarantine.ts, tests/quarantine.json).
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const FLAKE_LIMIT = 3;

export type Runs = Map<string, { pass: number; fail: number }>;
export type History = Record<string, { count: number; last: string }>;

const unXml = (s: string): string =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+);/g, (_, e: string) =>
    e.startsWith("#")
      ? String.fromCharCode(Number(e.slice(1)))
      : ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[e] as string),
  );

export function parseJunit(xml: string): Runs {
  const runs: Runs = new Map();
  const cases = xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g);
  for (const m of cases) {
    const attr = (name: string): string => unXml(new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]!)?.[1] ?? "");
    const inner = m[2] ?? "";
    if (/<skipped\b/.test(inner)) continue;
    const key = `${attr("file")}::${attr("name")}`;
    const run = runs.get(key) ?? { pass: 0, fail: 0 };
    if (/<(?:failure|error)\b/.test(inner)) run.fail++;
    else run.pass++;
    runs.set(key, run);
  }
  return runs;
}

export const flakesIn = (all: Runs): string[] =>
  [...all].filter(([, runs]) => runs.pass > 0 && runs.fail > 0).map(([key]) => key);

export function record(history: History, flakes: string[], today: string): History {
  const next: History = { ...history };
  for (const key of flakes) next[key] = { count: (next[key]?.count ?? 0) + 1, last: today };
  return next;
}

export const mustQuarantine = (history: History, runs: Runs): string[] =>
  Object.entries(history)
    .filter(([k, h]) => h.count >= FLAKE_LIMIT && runs.has(k))
    .map(([k]) => k);

if (import.meta.main) {
  const [historyPath, ...reports] = process.argv.slice(2);
  if (!historyPath || reports.length === 0) {
    console.error("usage: bun scripts/flake-report.ts <history.json> <junit.xml>...");
    process.exit(2);
  }
  const runs: Runs = new Map();
  for (const path of reports) {
    for (const [k, r] of parseJunit(readFileSync(path, "utf8"))) {
      const have = runs.get(k) ?? { pass: 0, fail: 0 };
      runs.set(k, { pass: have.pass + r.pass, fail: have.fail + r.fail });
    }
  }
  const before: History = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : {};
  const flakes = flakesIn(runs);
  const history = record(before, flakes, new Date().toISOString().slice(0, 10));
  writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);
  console.log(`| test | passed | failed | flips so far |\n| --- | --- | --- | --- |`);
  for (const k of flakes) console.log(`| ${k} | ${runs.get(k)!.pass} | ${runs.get(k)!.fail} | ${history[k]!.count} |`);
  if (flakes.length === 0) console.log("| none | | | |");
  const must = mustQuarantine(history, runs);
  for (const k of must) {
    const [file, name] = k.split("::") as [string, string];
    console.error(
      `quarantine ${file} "${name}": flaked ${history[k]!.count} times; tag it and add an entry to tests/quarantine.json`,
    );
  }
  if (must.length) process.exit(1);
}
