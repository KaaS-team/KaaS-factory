// Deletes `feat/*` branches whose PR merged (#586). A branch is deleted only when a PR from it merged, no
// PR from it is open, and its tip is the commit that merged. Anything else is kept, so an unmerged branch
// is never touched. All calls are `gh api` REST through the injectable runner.
import type { CommandRunner } from "./github";

export type BranchVerdict = "deleted" | "kept" | "skipped";
interface Pr {
  state: string;
  merged_at: string | null;
  head: { sha: string };
}

const isFeat = (branch: string): boolean => branch.startsWith("feat/");

async function api<T>(gh: CommandRunner, args: string[]): Promise<T> {
  const r = await gh.run(["api", ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`gh api ${args.join(" ")} failed: ${r.stderr.trim() || "timed out"}`);
  return JSON.parse(r.stdout || "null") as T;
}

export async function deleteIfMerged(gh: CommandRunner, repo: string, branch: string): Promise<BranchVerdict> {
  if (!isFeat(branch)) return "skipped";
  const owner = repo.split("/")[0];
  const enc = encodeURIComponent(branch);
  const prs = await api<Pr[]>(gh, [`repos/${repo}/pulls?state=all&per_page=100&head=${owner}:${enc}`]);
  if (prs.some((p) => p.state === "open")) return "kept";
  const merged = prs.filter((p) => p.merged_at);
  const tip = await api<{ commit: { sha: string } }>(gh, [`repos/${repo}/branches/${enc}`]);
  if (!merged.some((p) => p.head.sha === tip.commit.sha)) return "kept";
  await api(gh, ["-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`]);
  return "deleted";
}

// The one-time sweep of what already merged. Returns the branches it deleted.
export async function sweepMerged(gh: CommandRunner, repo: string): Promise<string[]> {
  const rows = await api<{ name: string }[][]>(gh, ["--paginate", "--slurp", `repos/${repo}/branches?per_page=100`]);
  const deleted: string[] = [];
  for (const { name } of rows.flat().filter((b) => isFeat(b.name)))
    if ((await deleteIfMerged(gh, repo, name)) === "deleted") deleted.push(name);
  return deleted;
}
