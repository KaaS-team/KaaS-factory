import { SHARED_FILES } from "./shared-files";

// A file many separate PRs touch is where parallel PRs collide, so it is the one to shard.
export interface PrChange {
  readonly pr: string;
  readonly files: readonly string[];
}

export interface Hotspot {
  readonly file: string;
  readonly prs: number;
  readonly shared: boolean;
}

export function rankHotspots(changes: readonly PrChange[], min = 2, top = 20): Hotspot[] {
  const seen = new Map<string, Set<string>>();
  for (const c of changes) for (const f of c.files) (seen.get(f) ?? seen.set(f, new Set()).get(f)!).add(c.pr);
  return [...seen]
    .map(([file, prs]) => ({ file, prs: prs.size, shared: SHARED_FILES.includes(file) }))
    .filter((h) => h.prs >= min)
    .sort((a, b) => b.prs - a.prs || a.file.localeCompare(b.file))
    .slice(0, top);
}

const MARK = "\u0001";

// One change per commit of the first-parent history; a squash-merged PR is one commit.
export function parseLog(log: string): PrChange[] {
  return log
    .split(MARK)
    .filter((b) => b.trim())
    .map((block): PrChange | undefined => {
      const [subject = "", ...files] = block.split("\n").filter(Boolean);
      const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
      return pr ? { pr, files } : undefined;
    })
    .filter((c) => c !== undefined);
}

export function readChanges(cwd: string, count: number): PrChange[] {
  const p = Bun.spawnSync(
    ["git", "log", "--first-parent", `-n${count}`, "--no-renames", "--name-only", `--format=${MARK}%s`],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`git log failed: ${p.stderr.toString().trim()}`);
  return parseLog(p.stdout.toString());
}
