// Moves the old tests/mutations.json into one file per entry. An operator step, run once.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEGACY_LIST, type Mutation, mutationSlug, shardPath, shardText } from "./mutation-list";

export function splitMutations(root: string): number {
  const list: Mutation[] = JSON.parse(readFileSync(join(root, LEGACY_LIST), "utf8"));
  const bySlug = new Map<string, string>();
  for (const m of list) {
    const slug = mutationSlug(m.name);
    const other = bySlug.get(slug);
    if (other !== undefined) throw new Error(`"${other}" and "${m.name}" share the slug ${slug}`);
    bySlug.set(slug, m.name);
  }
  for (const m of list) {
    const path = join(root, shardPath(m.name));
    if (existsSync(path) && readFileSync(path, "utf8") !== shardText(m))
      throw new Error(`${path} exists with other text`);
  }
  for (const m of list) {
    const path = join(root, shardPath(m.name));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, shardText(m));
  }
  rmSync(join(root, LEGACY_LIST));
  return list.length;
}

if (import.meta.main) {
  const i = process.argv.indexOf("--root");
  const root = i >= 0 ? process.argv[i + 1]! : join(import.meta.dir, "..");
  console.log(`split-mutations: moved ${splitMutations(root)} entries to tests/mutations/`);
}
