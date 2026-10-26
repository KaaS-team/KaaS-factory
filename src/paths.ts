// Every path the runner touches (clones, worktrees, the state DB) is
// resolved from here, always absolute. Before this file, `bin/factory`
// passed `workspaces` (relative to whatever cwd `bun` started in) straight
// into `git worktree add`, while `claude` was later spawned with
// `cwd: worktree` computed the same way — on any machine where those two
// resolve differently (they always do: bun's cwd is the shell's cwd, not
// the repo dir), the agent ran outside a git checkout. FACTORY_HOME fixes
// the ambiguity once, for local, Docker and CI alike (audit finding #1).

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export function factoryHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.FACTORY_HOME ?? `${env.HOME ?? "."}/.factory`);
}

// A second repo (splitbill-demo, lwp-website, ...) sharing one FACTORY_HOME
// must never share a workspace or a state DB with the first: two repos each
// carrying an issue #3 would otherwise collide on one worktree and one row
// set. `repo` ("owner/name") namespaces both under FACTORY_HOME; omitting it
// keeps the pre-v2.6.2 shared path, which DEFAULT_DB_PATH and existing
// fixtures still rely on.
function repoHome(repo: string, env: NodeJS.ProcessEnv): string {
  // The repo arrives from a URL query too, so `../..` must never reach the path.
  const [owner, name, extra] = repo.split("/");
  const part = (s?: string) => !!s && /^[A-Za-z0-9_.-]+$/.test(s) && s !== "." && s !== "..";
  if (!part(owner) || !part(name) || extra !== undefined)
    throw new Error(`repo must be "owner/name", got ${JSON.stringify(repo)}`);
  return `${factoryHome(env)}/${owner}/${name}`;
}

export function workspacesDir(env: NodeJS.ProcessEnv = process.env, repo?: string): string {
  return repo ? `${repoHome(repo, env)}/workspaces` : `${factoryHome(env)}/workspaces`;
}

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env, repo?: string): string {
  return repo ? `${repoHome(repo, env)}/factory.db` : `${factoryHome(env)}/factory.db`;
}

export function reposDir(env: NodeJS.ProcessEnv = process.env): string {
  return `${factoryHome(env)}/repos`;
}

// The legacy top-level dirs under FACTORY_HOME that are not an owner name.
const RESERVED_TOP_LEVEL = new Set(["repos", "workspaces"]);

// Every "owner/name" with a state DB under FACTORY_HOME, for the multi-repo
// inbox (v2.9.0 item 2, pulled forward from v3.0's blueprint plan). A repo
// only counts once it has run at least once (its factory.db exists), so a
// stray empty directory never shows up as a phantom repo.
export function discoverRepos(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = factoryHome(env);
  if (!existsSync(home)) return [];
  const repos: string[] = [];
  for (const owner of readdirSync(home, { withFileTypes: true })) {
    if (!owner.isDirectory() || RESERVED_TOP_LEVEL.has(owner.name)) continue;
    const ownerDir = `${home}/${owner.name}`;
    for (const name of readdirSync(ownerDir, { withFileTypes: true })) {
      if (name.isDirectory() && existsSync(`${ownerDir}/${name.name}/factory.db`))
        repos.push(`${owner.name}/${name.name}`);
    }
  }
  return repos.sort();
}

// The one list of repos a dashboard serves and a plane mirrors: FACTORY_REPOS when set, else every
// repo that has run here, plus the repo a dashboard was started for.
export function servedRepos(env: NodeJS.ProcessEnv = process.env, primary = ""): string[] {
  const listed = (env.FACTORY_REPOS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(isRepoName);
  return [...new Set([...(primary ? [primary] : []), ...(listed.length ? listed : discoverRepos(env))])];
}

export function isRepoName(repo: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.split("/").some((p) => p === "." || p === "..");
}

// Where a given issue's worktree lives, always absolute regardless of what
// cwd the process was started from.
export function worktreePath(issue: number, env: NodeJS.ProcessEnv = process.env, repo?: string): string {
  return `${workspacesDir(env, repo)}/issue-${issue}`;
}

// Per-issue run files outside the worktree: the transcript every stage appends
// to (the live view and the local recording) and the live file naming the
// running process, which `factory takeover` reads.
export function transcriptPath(repo: string, issue: number, env: NodeJS.ProcessEnv = process.env): string {
  return `${repoHome(repo, env)}/transcripts/issue-${issue}.log`;
}

// The agent's raw output beside the transcript, which `factory view` renders in colour.
export function streamPath(transcriptFile: string): string {
  return transcriptFile.replace(/(\.log)?$/, ".stream.jsonl");
}

export function livePath(repo: string, issue: number, env: NodeJS.ProcessEnv = process.env): string {
  return `${repoHome(repo, env)}/live/issue-${issue}.json`;
}

// Written by `factory takeover` before it stops the stage, so the executor
// can tell an operator's stop from a crash.
export function takeoverMarker(liveFile: string): string {
  return `${liveFile.replace(/\.json$/, "")}.takeover`;
}
