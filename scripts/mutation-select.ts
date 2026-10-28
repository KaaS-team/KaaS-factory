// On a PR only the mutations the diff can affect run; the nightly run does the rest.

export interface Scoped {
  readonly file: string;
  readonly test: string;
}

// Changing the runner or the list itself can change any verdict, so those run everything.
const RUNS_ALL = new Set(["scripts/check-mutations.ts", "scripts/mutation-select.ts", "tests/mutations.json"]);

export function selectMutations<T extends Scoped>(all: readonly T[], changed: readonly string[]): T[] {
  if (changed.some((f) => RUNS_ALL.has(f))) return [...all];
  const touched = new Set(changed);
  return all.filter((m) => touched.has(m.file) || touched.has(m.test.replace(/^\.\//, "")));
}
