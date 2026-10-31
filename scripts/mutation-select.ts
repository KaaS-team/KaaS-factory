// On a PR only the mutations the diff can affect run; the nightly run does the rest.

import { shardPath } from "./mutation-list";

export interface Scoped {
  readonly name: string;
  readonly file: string;
  readonly test: string;
  // Files the test reads that are neither `file` nor `test`, added when a selector miss names them.
  readonly inputs?: readonly string[];
}

// Changing the runner can change any verdict, so it runs everything.
const RUNS_ALL = new Set([
  "scripts/check-mutations.ts",
  "scripts/mutation-select.ts",
  "scripts/mutation-list.ts",
  "scripts/repo-copy.ts",
]);
const LIST = "tests/mutations.json";

// `before` is the list at the base ref. When only the list changed, the entries that are new or edited run,
// not the whole list: an entry that is byte-identical to the base one already bit there.
export function selectMutations<T extends Scoped & { readonly name: string }>(
  all: readonly T[],
  changed: readonly string[],
  before?: readonly T[],
): T[] {
  if (changed.some((f) => RUNS_ALL.has(f))) return [...all];
  if (changed.includes(LIST) && !before) return [...all];
  const touched = new Set(changed);
  const known = new Set((before ?? []).map((m) => JSON.stringify(m)));
  return all.filter(
    (m) =>
      touched.has(shardPath(m.name)) ||
      touched.has(m.file) ||
      touched.has(m.test.replace(/^\.\//, "")) ||
      (m.inputs ?? []).some((f) => touched.has(f)) ||
      (touched.has(LIST) && !known.has(JSON.stringify(m))),
  );
}
