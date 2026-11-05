// The mutation list: the old tests/mutations.json plus one file per entry in tests/mutations/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readBaseline } from "../src/baseline-shards";

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

// {{lines:src/cli.ts}} is that file's cap in quality-baseline/lines, {{lines:src/cli.ts+69}} is the cap plus 69.
// A mutation names the cap instead of copying it, so a size change to the file edits one shard (#634).
const CAP = /\{\{lines:([^}+]+)(?:\+(\d+))?\}\}/g;

export function resolveCaps(text: string, lines: Readonly<Record<string, number>>, where: string): string {
  return text.replace(CAP, (_, file: string, plus?: string) => {
    const cap = lines[file];
    if (cap === undefined) throw new Error(`${where}: no line baseline for ${file}`);
    return String(cap + Number(plus ?? 0));
  });
}

// The line caps a mutation copies as plain numbers, which go stale when the baseline shard is lowered.
export function pinnedCaps(m: Mutation, lines: Readonly<Record<string, number>>): string[] {
  const caps = new Set(Object.values(lines).map(String));
  return [m.find, m.replace].flatMap((t) => (t.match(/(?<![\w.])\d+(?![\w.])/g) ?? []).filter((n) => caps.has(n)));
}

export function loadMutations(root: string): Mutation[] {
  const legacyPath = join(root, LEGACY_LIST);
  const legacy: Mutation[] = existsSync(legacyPath) ? JSON.parse(readFileSync(legacyPath, "utf8")) : [];
  const dir = join(root, MUTATIONS_DIR);
  const shards: Mutation[] = [];
  const lines = readBaseline(root).metrics.lines ?? {};
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      const rel = `${MUTATIONS_DIR}/${f}`;
      const m: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!isMutation(m)) throw new Error(`${rel}: not a mutation`);
      if (rel !== shardPath(m.name)) throw new Error(`${rel}: file name must be ${shardPath(m.name)}`);
      shards.push({ ...m, find: resolveCaps(m.find, lines, rel), replace: resolveCaps(m.replace, lines, rel) });
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

// The one result a run posts: how many mutations ran, how many held (their test went red), which did not.
export function mutationSummary(ran: readonly string[], failed: readonly string[]): string {
  const held = ran.length - failed.length;
  const head = `check-mutations: ${ran.length} ran, ${held} held, ${failed.length} did not`;
  return failed.length ? `${head}\n${failed.map((n) => `- ${n}`).join("\n")}` : head;
}
