// make check-anchors: a mutation whose `find` no longer matches its file exactly once never bites.
// This is the cheap pass over the whole list (tests/mutations.json and tests/mutations/*.json); check-mutations.ts is the slow one that runs the tests.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadMutations } from "./mutation-list";

interface Entry {
  readonly name: string;
  readonly file: string;
  readonly find: string;
}

export function anchorProblems(entries: readonly Entry[], read: (file: string) => string | undefined): string[] {
  const problems: string[] = [];
  for (const { name, file, find } of entries) {
    const text = read(file);
    if (text === undefined) {
      problems.push(`${name}: file ${file} is missing`);
      continue;
    }
    if (find === "") {
      problems.push(`${name}: find is empty`);
      continue;
    }
    const count = text.split(find).length - 1;
    if (count !== 1) problems.push(`${name}: find matches ${count} times in ${file}, expected 1`);
  }
  return problems;
}

export const readRepoFile =
  (root: string) =>
  (file: string): string | undefined => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch {
      return undefined;
    }
  };

// The per-entry files are part of the list: a moved target there must fail by name too.
export function repoAnchorProblems(root: string): { problems: string[]; count: number } {
  const entries: Entry[] = loadMutations(root);
  return { problems: anchorProblems(entries, readRepoFile(root)), count: entries.length };
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const { problems, count } = repoAnchorProblems(root);
  if (problems.length > 0) {
    console.error(`check-mutation-anchors: ${problems.length} problem(s)\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`check-mutation-anchors: ok (${count} entries)`);
}
