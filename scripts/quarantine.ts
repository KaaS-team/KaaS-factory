// Quarantine policy: a test that flips is tagged, owned and given an expiry. The tag stays the one the Makefile
// filters on; tests/quarantine.json holds the owner and the date it must come back.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const QUARANTINE_TAG = "@" + "quarantine";
export const MAX_DAYS = 30;

export interface Entry {
  file: string;
  test: string;
  owner: string;
  added: string;
  expires: string;
  issue: string;
}

const FIX = "fix it, delete it, or renew it with a new expiry";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CALL = /\b(?:test|it)(?:\.\w+)?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

export const loadLedger = (path = "tests/quarantine.json"): Entry[] =>
  JSON.parse(readFileSync(path, "utf8")) as Entry[];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".test.ts") ? [p] : [];
  });
}

export function tagged(dir = "tests"): { file: string; test: string }[] {
  const out: { file: string; test: string }[] = [];
  for (const file of walk(dir)) {
    for (const m of readFileSync(file, "utf8").matchAll(CALL))
      if (m[2]!.includes(QUARANTINE_TAG)) out.push({ file, test: m[2]! });
  }
  return out;
}

const days = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 86_400_000;

export function quarantineProblems(
  entries: Entry[],
  taggedTests: { file: string; test: string }[],
  today: string,
): string[] {
  const out: string[] = [];
  for (const t of taggedTests) {
    if (!entries.some((e) => e.file === t.file && e.test === t.test))
      out.push(`${t.file} "${t.test}" is tagged ${QUARANTINE_TAG} with no entry in tests/quarantine.json`);
  }
  for (const entry of entries) {
    const where = `${entry.file} "${entry.test}"`;
    if (!taggedTests.some((t) => t.file === entry.file && t.test === entry.test))
      out.push(`${where} has a quarantine entry but is no longer tagged (stale): delete the entry`);
    for (const key of ["owner", "added", "expires", "issue"] as const)
      if (!entry[key]) out.push(`${where} has no ${key}`);
    if (entry.owner && !entry.owner.startsWith("@")) out.push(`${where} owner "${entry.owner}" must start with @`);
    const dated = DATE.test(entry.added ?? "") && DATE.test(entry.expires ?? "");
    for (const key of ["added", "expires"] as const)
      if (entry[key] && !DATE.test(entry[key])) out.push(`${where} ${key} "${entry[key]}" is not YYYY-MM-DD`);
    if (dated && days(entry.added, entry.expires) > MAX_DAYS)
      out.push(`${where} expires ${entry.expires}, more than ${MAX_DAYS} days after ${entry.added}`);
    if (entry.expires < today) out.push(`${where} expired on ${entry.expires}: ${FIX}`);
  }
  return out;
}
