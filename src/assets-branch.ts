// Before and after screenshots for a UI PR, kept on the orphan branch `factory/assets` so the PR body can
// link raw URLs. Built with git plumbing and a throwaway index: the worktree's HEAD, index and files never move.

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "./artifacts";
import { isUiChange } from "./visual";

export const ASSETS_BRANCH = "factory/assets";

export interface ShotPair {
  readonly name: string;
  readonly before?: string;
  readonly after: string;
}

// `git` runs one command in a directory and returns its trimmed stdout; env is added to the process.
export type RunGit = (cwd: string, args: string[], env?: Record<string, string>) => Promise<string>;

export const runGit: RunGit = async (cwd, args, env) => {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args[0]}: ${err.trim()}`);
  return out.trim();
};

const pngs = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")) : []);

// Files in `currentDir` matched by name to the committed baseline; a shot with no baseline has no `before`.
export function pairShots(baselineDir: string, currentDir: string): ShotPair[] {
  return pngs(currentDir)
    .sort()
    .map((name) => ({
      name,
      ...(existsSync(join(baselineDir, name)) ? { before: join(baselineDir, name) } : {}),
      after: join(currentDir, name),
    }));
}

// Adds <issue>/before/ and <issue>/after/ to the remote branch as one new commit and pushes it.
// The first push has no parent; later ones parent on the remote head, so history only grows.
export async function pushAssets(
  git: RunGit,
  worktree: string,
  issue: number,
  pairs: readonly ShotPair[],
): Promise<string> {
  const remote = await git(worktree, ["ls-remote", "origin", `refs/heads/${ASSETS_BRANCH}`]);
  const head = remote ? remote.split(/\s/)[0] : undefined;
  if (head) await git(worktree, ["fetch", "--no-tags", "origin", `refs/heads/${ASSETS_BRANCH}`]);
  const tmp = mkdtempSync(join(tmpdir(), "factory-assets-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    if (head) await git(worktree, ["read-tree", head], env);
    for (const p of pairs) {
      for (const [side, file] of [
        ["before", p.before],
        ["after", p.after],
      ] as const) {
        if (!file) continue;
        const blob = await git(worktree, ["hash-object", "-w", file]);
        await git(worktree, ["update-index", "--add", "--cacheinfo", `100644,${blob},${issue}/${side}/${p.name}`], env);
      }
    }
    const tree = await git(worktree, ["write-tree"], env);
    const parent = head ? ["-p", head] : [];
    const sha = await git(
      worktree,
      [
        "-c",
        "user.name=kaas-factory",
        "-c",
        "user.email=factory@users.noreply.github.com",
        "commit-tree",
        tree,
        ...parent,
        "-m",
        `shots for #${issue}`,
      ],
      env,
    );
    await git(worktree, ["push", "origin", `${sha}:refs/heads/${ASSETS_BRANCH}`]);
    return sha;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface ShotUrls {
  readonly name: string;
  readonly before?: string;
  readonly after: string;
}

export function shotUrls(repo: string, issue: number, pairs: readonly ShotPair[]): ShotUrls[] {
  const url = (side: string, name: string) =>
    `https://raw.githubusercontent.com/${repo}/${ASSETS_BRANCH}/${issue}/${side}/${name}`;
  return pairs.map((p) => ({
    name: p.name,
    ...(p.before ? { before: url("before", p.name) } : {}),
    after: url("after", p.name),
  }));
}

export function shotsSection(shots: readonly ShotUrls[]): string {
  const rows = shots.map(
    (s) => `| ${s.before ? `![before ${s.name}](${s.before})` : "new screen"} | ![after ${s.name}](${s.after}) |`,
  );
  return ["## Screenshots", "", "| Before | After |", "| --- | --- |", ...rows].join("\n");
}

// The pr step's one call: for a UI change, pushes the pairs, records the URLs in shots.json for the
// preview tab, and returns the URLs. A non-UI change, or no shots, does nothing.
export async function publishShots(
  git: RunGit,
  worktree: string,
  o: { repo: string; issue: number; changed: readonly string[] },
): Promise<ShotUrls[] | undefined> {
  if (!isUiChange(o.changed)) return undefined;
  const pairs = pairShots(join(worktree, ".factory/visual/baseline"), join(worktree, runDir(o.issue), "visual"));
  if (pairs.length === 0) return undefined;
  await pushAssets(git, worktree, o.issue, pairs);
  const urls = shotUrls(o.repo, o.issue, pairs);
  writeFileSync(join(worktree, runDir(o.issue), "shots.json"), `${JSON.stringify(urls, null, 2)}\n`);
  return urls;
}
