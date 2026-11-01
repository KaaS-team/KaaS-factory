// While a rebase is stopped, re-sync the two shared files that parallel PRs both edit:
// quality-baseline.json (line caps) and tests/mutations.json (the old mutation list).
// Any other conflict is a real one and the caller aborts as before.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function pick3<T>(
  ours: T | undefined,
  theirs: T | undefined,
  base: T | undefined,
): { value: T | undefined } | undefined {
  if (ours === theirs || theirs === base) return { value: ours };
  if (ours === base) return { value: theirs };
  return undefined;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (v === undefined ? undefined : JSON.stringify(v));
const unstr = (s: string | undefined): unknown => (s === undefined ? undefined : JSON.parse(s));
const lineCount = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

export function mergeBaseline(
  ours: string,
  theirs: string,
  base: string | undefined,
  worktree: string,
): string | undefined {
  const o = JSON.parse(ours) as Obj;
  const t = JSON.parse(theirs) as Obj;
  const b = (base === undefined ? {} : JSON.parse(base)) as Obj;
  const out: Obj = {};
  for (const key of [...Object.keys(o), ...Object.keys(t).filter((k) => !(k in o))]) {
    if (key === "lines") continue;
    if (isObj(o[key]) && isObj(t[key])) {
      const [oi, ti] = [o[key] as Obj, t[key] as Obj];
      const bi = isObj(b[key]) ? (b[key] as Obj) : {};
      const inner: Obj = {};
      for (const k of [...new Set([...Object.keys(oi), ...Object.keys(ti)])].sort()) {
        const pick = pick3(str(oi[k]), str(ti[k]), str(bi[k]));
        if (!pick) return undefined;
        if (pick.value !== undefined) inner[k] = unstr(pick.value);
      }
      out[key] = inner;
    } else {
      const pick = pick3(str(o[key]), str(t[key]), str(b[key]));
      if (!pick) return undefined;
      if (pick.value !== undefined) out[key] = unstr(pick.value);
    }
  }
  const lines: Record<string, number> = {};
  const files = new Set([...Object.keys((o.lines as Obj) ?? {}), ...Object.keys((t.lines as Obj) ?? {})]);
  for (const file of [...files].sort()) {
    const path = join(worktree, file);
    if (existsSync(path)) lines[file] = lineCount(readFileSync(path, "utf8"));
  }
  out.lines = lines;
  // Keep ours' top-level key order.
  const ordered: Obj = {};
  for (const k of [...Object.keys(o), ...Object.keys(out)]) if (k in out) ordered[k] = out[k];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function entryLines(text: string): Map<string, string> | undefined {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "[" && l !== "]");
  const byName = new Map<string, string>();
  for (const row of rows) {
    const line = row.endsWith(",") ? row.slice(0, -1) : row;
    try {
      const name = (JSON.parse(line) as { name?: unknown }).name;
      if (typeof name !== "string") return undefined;
      byName.set(name, line);
    } catch {
      return undefined;
    }
  }
  return byName;
}

export function mergeMutationList(ours: string, theirs: string, base: string | undefined): string | undefined {
  const [o, t] = [entryLines(ours), entryLines(theirs)];
  const b = base === undefined ? new Map<string, string>() : entryLines(base);
  if (!o || !t || !b) return undefined;
  const names = [...o.keys(), ...[...t.keys()].filter((n) => !o.has(n))];
  const kept: string[] = [];
  for (const name of names) {
    const pick = pick3(o.get(name), t.get(name), b.get(name));
    if (!pick) return undefined;
    if (pick.value !== undefined) kept.push(pick.value);
  }
  return `[\n${kept.map((l) => `  ${l}`).join(",\n")}\n]\n`;
}

async function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited, new Response(p.stderr).text()]);
  return { code, out };
}

const MERGERS: Record<string, (o: string, t: string, b: string | undefined, wt: string) => string | undefined> = {
  "quality-baseline.json": mergeBaseline,
  "tests/mutations.json": (o, t, b) => mergeMutationList(o, t, b),
};

export async function syncRebase(worktree: string): Promise<boolean> {
  for (let pass = 0; pass < 200; pass++) {
    const inRebase = (await run(worktree, ["rev-parse", "--git-path", "rebase-merge"])).out.trim();
    if (!existsSync(join(worktree, inRebase))) return false;
    const unmerged = (await run(worktree, ["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean);
    if (unmerged.some((p) => !(p in MERGERS))) return false;
    for (const path of unmerged) {
      const stage = async (n: number) => {
        const r = await run(worktree, ["show", `:${n}:${path}`]);
        return r.code === 0 ? r.out : undefined;
      };
      const [base, ours, theirs] = [await stage(1), await stage(2), await stage(3)];
      if (ours === undefined || theirs === undefined) return false;
      const merged = MERGERS[path]!(ours, theirs, base, worktree);
      if (merged === undefined) return false;
      writeFileSync(join(worktree, path), merged);
      if ((await run(worktree, ["add", path])).code !== 0) return false;
    }
    const cont = await run(worktree, ["rebase", "--continue"], { GIT_EDITOR: "true" });
    if (cont.code === 0) {
      const dir = (await run(worktree, ["rev-parse", "--git-path", "rebase-merge"])).out.trim();
      if (!existsSync(join(worktree, dir))) return true;
    } else {
      const left = (await run(worktree, ["diff", "--name-only", "--diff-filter=U"])).out.trim();
      if (!left && (await run(worktree, ["diff", "--cached", "--quiet"])).code === 0)
        await run(worktree, ["rebase", "--skip"]);
    }
  }
  return false;
}
