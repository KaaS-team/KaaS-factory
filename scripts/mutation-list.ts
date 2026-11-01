// The mutation list: the old tests/mutations.json plus one file per entry in tests/mutations/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Mutation {
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly test: string;
}

export const LEGACY_LIST = "tests/mutations.json";
export const MUTATIONS_DIR = "tests/mutations";

const KEYS = ["name", "file", "find", "replace", "test"] as const;
export const isMutation = (m: unknown): m is Mutation =>
  typeof m === "object" && m !== null && KEYS.every((k) => typeof (m as Record<string, unknown>)[k] === "string");

export const mutationSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");

export const shardPath = (name: string): string => `${MUTATIONS_DIR}/${mutationSlug(name)}.json`;

export function loadMutations(root: string): Mutation[] {
  const legacyPath = join(root, LEGACY_LIST);
  const legacy: Mutation[] = existsSync(legacyPath) ? JSON.parse(readFileSync(legacyPath, "utf8")) : [];
  const dir = join(root, MUTATIONS_DIR);
  const shards: Mutation[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      const rel = `${MUTATIONS_DIR}/${f}`;
      const m: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!isMutation(m)) throw new Error(`${rel}: not a mutation`);
      if (rel !== shardPath(m.name)) throw new Error(`${rel}: file name must be ${shardPath(m.name)}`);
      shards.push(m);
    }
  }
  const all = [...legacy, ...shards];
  const seen = new Set<string>();
  for (const { name } of all) {
    if (seen.has(name)) throw new Error(`mutation "${name}" is listed twice`);
    seen.add(name);
  }
  return all;
}

export const shardText = (m: Mutation): string =>
  `${JSON.stringify({ name: m.name, file: m.file, find: m.find, replace: m.replace, test: m.test }, null, 2)}\n`;
