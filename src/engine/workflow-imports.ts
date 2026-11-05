// `imports:` in a workflow file names fragments to merge under it: `shared/<name>` is
// .factory/workflows/shared/<name>.yml, `org/<name>` and `team/<team>/<name>` are the entry
// `workflows.<name>` in .factory/team/org.yml or teams/<team>.yml. Local files only.

import { join } from "node:path";

type Obj = Record<string, unknown>;
export type ReadFile = (path: string) => Promise<string | undefined>;
export type Imported = { ok: true; raw: Obj; texts: string[] } | { ok: false; problems: string[] };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const FRAGMENT_KEYS = new Set(["description", "on", "limits", "steps", "imports"]);
const REF = /^(shared\/[\w-]+|org\/[\w-]+|team\/[\w-]+\/[\w-]+)$/;

// The importer wins on a clash and keeps its keys first, so its first step stays the start;
// mappings merge by key, anything else is replaced.
function merge(under: Obj, over: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(under[k]) ? merge(under[k], v) : v;
  for (const [k, v] of Object.entries(under)) if (!(k in out)) out[k] = v;
  return out;
}

async function fragment(cloneDir: string, ref: string, read: ReadFile): Promise<{ raw: Obj; text: string } | string> {
  const [kind, a, b] = ref.split("/") as [string, string, string | undefined];
  const parse = (text: string, where: string): unknown => {
    try {
      return Bun.YAML.parse(text);
    } catch (e) {
      throw new Error(`imports: ${ref} (${where}) is not valid YAML: ${(e as Error).message}`);
    }
  };
  try {
    if (kind === "shared") {
      const where = `.factory/workflows/shared/${a}.yml`;
      const text = await read(join(cloneDir, where));
      if (text === undefined) return `imports: ${ref} not found (${where})`;
      const raw = parse(text, where);
      return isObj(raw) ? { raw, text } : `imports: ${ref} (${where}) is not a mapping`;
    }
    const where = kind === "org" ? ".factory/team/org.yml" : `.factory/team/teams/${a}.yml`;
    const name = kind === "org" ? a : b;
    const text = await read(join(cloneDir, where));
    if (text === undefined) return `imports: ${ref} not found (${where})`;
    const file = parse(text, where);
    const entry = isObj(file) && isObj(file.workflows) ? file.workflows[name!] : undefined;
    return isObj(entry)
      ? { raw: entry, text: JSON.stringify(entry) }
      : `imports: ${ref} not found (no workflows.${name} in ${where})`;
  } catch (e) {
    return (e as Error).message;
  }
}

// Resolves `raw.imports` depth first. `texts` is every fragment's source, for the workflow's sha:
// a changed fragment is a changed workflow, so a resume never replays steps of the old one.
export async function resolveImports(raw: Obj, cloneDir: string, read: ReadFile): Promise<Imported> {
  const texts: string[] = [];
  const expand = async (node: Obj, chain: string[]): Promise<Obj | string> => {
    const refs = node.imports;
    const { imports: _drop, ...rest } = node;
    if (refs === undefined) return rest;
    if (!Array.isArray(refs) || !refs.every((r) => typeof r === "string" && REF.test(r)))
      return "imports: a list of shared/<name>, org/<name> or team/<team>/<name>";
    let base: Obj = {};
    for (const ref of refs as string[]) {
      if (chain.includes(ref)) return `imports: cycle ${[...chain, ref].join(" -> ")}`;
      const got = await fragment(cloneDir, ref, read);
      if (typeof got === "string") return got;
      const bad = Object.keys(got.raw).find((k) => !FRAGMENT_KEYS.has(k));
      if (bad)
        return `imports: ${ref} has "${bad}", which a fragment cannot set (allowed: ${[...FRAGMENT_KEYS].join(", ")})`;
      texts.push(got.text);
      const inner = await expand(got.raw, [...chain, ref]);
      if (typeof inner === "string") return inner;
      base = merge(base, inner);
    }
    return merge(base, rest);
  };
  const out = await expand(raw, []);
  return typeof out === "string" ? { ok: false, problems: [out] } : { ok: true, raw: out, texts };
}
