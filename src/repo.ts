// Resolves `--repo owner/name` into a local clone under FACTORY_HOME/repos,
// cloning on first use and fast-forwarding to origin's default branch on
// every call after — the piece that lets a Docker or CI container start
// with nothing on disk (plan "Run anywhere": VM mode is `up --repo
// owner/name`; CI's `factory run`/`tick` accept the same flag). Local mode
// keeps using `--repo-dir <path>` and never touches this file.

import { existsSync } from "node:fs";
import type { CommandRunner } from "./github";
import { reposDir } from "./paths";

// The GitHub host: github.com, or a GitHub Enterprise Server named by GH_HOST,
// the variable gh itself reads, so the CLI calls and the clone URLs agree.
export function githubHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.GH_HOST?.trim() || "github.com";
}

export function cloneDirFor(repoSlug: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${reposDir(env)}/${repoSlug.replace("/", "__")}`;
}

async function run(runner: CommandRunner, args: string[], cwd?: string): Promise<string> {
  const result = await runner.run(args, cwd ? { cwd } : undefined);
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")} (cwd=${cwd ?? "."}) failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

// The runner's clone pushes through gh's own login. Without this it inherits
// the machine's helper, and macOS's osxkeychain opens a dialog that a headless
// run waits on forever (the v3.1 live run hung six minutes on its claim push).
// The empty entry clears every inherited helper before gh's is added.
export const GH_CREDENTIAL_HELPER = "!gh auth git-credential";

async function useGhCredentials(runner: CommandRunner, dir: string): Promise<void> {
  await run(runner, ["config", "--local", "--replace-all", "credential.helper", ""], dir);
  await run(runner, ["config", "--local", "--add", "credential.helper", GH_CREDENTIAL_HELPER], dir);
}

export interface EnsureRepoCloneOptions {
  readonly env?: NodeJS.ProcessEnv;
  // Overrides the clone URL; tests point this at a local bare repo instead
  // of https://<githubHost>/<repoSlug>.git.
  readonly remoteUrl?: string;
}

export async function ensureRepoClone(
  runner: CommandRunner,
  repoSlug: string,
  opts: EnsureRepoCloneOptions = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const dir = cloneDirFor(repoSlug, env);
  const remoteUrl = opts.remoteUrl ?? `https://${githubHost(env)}/${repoSlug}.git`;

  if (!existsSync(`${dir}/.git`)) {
    await run(runner, ["clone", remoteUrl, dir]);
    await useGhCredentials(runner, dir);
    return dir;
  }
  await useGhCredentials(runner, dir);

  // Already cloned from an earlier container start: fetch and fast-forward
  // to whatever origin's default branch currently is, discarding any local
  // drift — a stateless CI/VM clone is never a place to keep local commits.
  await run(runner, ["fetch", "--prune", "origin"], dir);
  const defaultRef = await run(runner, ["rev-parse", "--abbrev-ref", "origin/HEAD"], dir); // "origin/main"
  const defaultBranch = defaultRef.replace(/^origin\//, "");
  await run(runner, ["checkout", defaultBranch], dir);
  await run(runner, ["reset", "--hard", `origin/${defaultBranch}`], dir);
  return dir;
}
