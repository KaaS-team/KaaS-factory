// Which `gh pr merge` flags a repo's merge settings mean, and whether the factory may rebase first.
// Absent settings are today's behaviour: --squash, factory-run queue, rebase before merge.
import { type CommandRunner, GhCommandRunner } from "./github";

export type MergeMethod = "squash" | "rebase" | "merge" | "host";
export type MergeQueue = "factory" | "host" | "none";
export interface MergeSettings {
  readonly method?: MergeMethod;
  readonly queue?: MergeQueue;
}

// Host mode: the host owns the merge, so the factory enables auto-merge and nothing else.
export const isHostRun = (s: MergeSettings | undefined): boolean => s?.method === "host" || s?.queue === "host";

// A rebase rewrites the head: it clears human approvals and drops the PR from a host merge queue.
// Queue "none" merges the head as it stands.
export const mayRebase = (s: MergeSettings | undefined): boolean => !isHostRun(s) && s?.queue !== "none";

export function mergeArgs(repo: string, number: number, headSha: string, s?: MergeSettings): string[] {
  const flag = s?.method === "rebase" ? "--rebase" : s?.method === "merge" ? "--merge" : "--squash";
  return [
    "pr",
    "merge",
    String(number),
    "--repo",
    repo,
    ...(isHostRun(s) ? ["--auto"] : []),
    ...(s?.method === "host" ? [] : [flag]),
    "--match-head-commit",
    headSha,
  ];
}

const REPO_FLAG = { squash: "allow_squash_merge", rebase: "allow_rebase_merge", merge: "allow_merge_commit" } as const;

// The doctor row: the configured method against what the repo allows (and auto-merge, for host mode).
export async function mergeMethodCheck(
  config: { repo: string; merge: MergeSettings },
  gh: CommandRunner = new GhCommandRunner(),
) {
  const { repo, merge: s } = config;
  const method = s.method ?? "squash";
  const name = "merge method is allowed by the repo";
  const res = await gh.run(["api", `repos/${repo}`]);
  let info: Record<string, unknown> = {};
  try {
    info = JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {
    info = {};
  }
  if (res.code !== 0 || Object.keys(info).length === 0)
    return {
      name,
      ok: true,
      warn: true,
      detail: `could not read ${repo} settings, so merge.method "${method}" is unchecked`,
      fixable: false,
    };
  const bad: string[] = [];
  if (method !== "host" && info[REPO_FLAG[method]] === false)
    bad.push(`merge.method "${method}" but ${repo} has ${REPO_FLAG[method]} off`);
  if (isHostRun(s) && info.allow_auto_merge === false)
    bad.push(`host mode needs allow_auto_merge, which ${repo} has off`);
  return {
    name,
    ok: bad.length === 0,
    detail: bad.length === 0 ? `"${method}" is allowed` : bad.join("; "),
    fixable: false,
  };
}
