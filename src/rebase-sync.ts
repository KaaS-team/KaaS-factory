// While a rebase is stopped, re-sync the shared files that parallel PRs both edit:
// quality-baseline/ (a shard conflicts only when both sides moved one cap) and tests/mutations.json.
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

const lineCount = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

// A baseline entry is its own file, so it conflicts only when both sides changed the same cap.
// A line cap is re-measured from the worktree; a cap whose file is gone gives up the sync.
export function mergeShard(
  ours: string,
  theirs: string,
  base: string | undefined,
  worktree: string,
  path: string,
): string | undefined {
  const entry = JSON.parse(ours) as { file: string; max: number };
  if (path.startsWith("quality-baseline/lines/")) {
    const file = join(worktree, entry.file);
    if (!existsSync(file)) return undefined;
    return `${JSON.stringify({ file: entry.file, max: lineCount(readFileSync(file, "utf8")) })}\n`;
  }
  const pick = pick3(ours, theirs, base);
  return pick?.value;
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

type Merger = (o: string, t: string, b: string | undefined, wt: string, path: string) => string | undefined;
const MERGERS: Record<string, Merger> = {
  "tests/mutations.json": (o, t, b) => mergeMutationList(o, t, b),
};
const mergerFor = (path: string): Merger | undefined =>
  path.startsWith("quality-baseline/") ? mergeShard : MERGERS[path];

export async function syncRebase(worktree: string): Promise<boolean> {
  for (let pass = 0; pass < 200; pass++) {
    const inRebase = (await run(worktree, ["rev-parse", "--git-path", "rebase-merge"])).out.trim();
    if (!existsSync(join(worktree, inRebase))) return false;
    const unmerged = (await run(worktree, ["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean);
    if (unmerged.some((p) => !mergerFor(p))) return false;
    for (const path of unmerged) {
      const stage = async (n: number) => {
        const r = await run(worktree, ["show", `:${n}:${path}`]);
        return r.code === 0 ? r.out : undefined;
      };
      const [base, ours, theirs] = [await stage(1), await stage(2), await stage(3)];
      if (ours === undefined || theirs === undefined) return false;
      const merged = mergerFor(path)!(ours, theirs, base, worktree, path);
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
