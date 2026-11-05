// `factory watch --all`: one process polls every repo listed in machine.json "repos" through
// pollRegistry, which holds each repo's lease cap and the machine's cost cap. src/cli.ts dispatches here.

import { EXIT, successJson, UsageError } from "./cli-output";
import type { CliContext } from "./cli-runtime";
import { loadConfig } from "./config";
import { GitCommandRunner } from "./git";
import { loadMachineConfig } from "./machine";
import { type PollRepos, pollRegistry, type RepoSource } from "./registry-watch";
import { ensureRepoClone } from "./repo";
import { type RepoEntry, servedRepos } from "./repo-registry";
import { recoverInFlight } from "./watch";

export interface RegistryIo {
  cloneFor(repo: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  // True once the loop should end; checked after every pass. Unset runs until the process is stopped.
  stop?(): boolean;
}

const realIo: RegistryIo = {
  cloneFor: (repo) => ensureRepoClone(new GitCommandRunner(), repo),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const failed = (polled: PollRepos): string[] => Object.keys(polled).filter((r) => polled[r] && "error" in polled[r]);

export async function cmdWatchRegistry(cli: CliContext, io: RegistryIo = realIo): Promise<void> {
  const registry = loadMachineConfig().repos ?? [];
  const served = servedRepos(registry);
  if (!served.length)
    throw new UsageError('watch --all: FACTORY_HOME/machine.json lists no enabled repo under "repos"');

  // One source per repo, built on its first poll. A repo that fails to build is retried on the next pass.
  const sources = new Map<string, Promise<RepoSource>>();
  const sourceFor = (entry: RepoEntry): Promise<RepoSource> => {
    let s = sources.get(entry.repo);
    if (!s) {
      s = (async () => {
        const cloneDir = await io.cloneFor(entry.repo);
        const own = { ...(await loadConfig(cloneDir)), repo: entry.repo };
        const deps = await cli.watchDeps(cloneDir, own);
        const recovered = await recoverInFlight(deps, own);
        if (recovered.length) console.log(`factory watch: ${entry.repo} recovered #${recovered.join(", #")}`);
        return { deps, own };
      })();
      s.catch(() => sources.delete(entry.repo));
      sources.set(entry.repo, s);
    }
    return s;
  };

  const inFlight = new Map<string, Set<number>>();
  const intervalMs = Math.min(...served.map((e) => e.pollIntervalSeconds ?? 60)) * 1000;
  console.log(`factory watch: polling ${served.length} repo(s): ${served.map((e) => e.repo).join(", ")}`);
  for (;;) {
    const polled = await pollRegistry(registry, sourceFor, inFlight);
    const bad = failed(polled);
    for (const repo of bad)
      console.error(`factory watch: ${repo} failed: ${(polled[repo] as { error: string }).error}`);
    if (cli.has("once")) {
      console.log(cli.has("json") ? successJson(polled, !bad.length) : JSON.stringify(polled, null, 2));
      if (bad.length) process.exitCode = EXIT.error;
      return;
    }
    for (const [repo, r] of Object.entries(polled))
      if ("processed" in r && r.processed.length)
        console.log(`factory watch: ${repo} processed #${r.processed.join(", #")}`);
    if (io.stop?.()) return;
    await io.sleep(intervalMs);
  }
}
