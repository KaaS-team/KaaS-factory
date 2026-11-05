// One watcher for every registered repo: each poll visits each served repo in turn through
// pollOnce, which already holds the per-repo lease cap and the machine's cost cap. A repo whose
// poll throws is reported and skipped, so one bad repo never stops the others.

import type { FactoryConfig } from "./config";
import { configForEntry, type RepoEntry, type RepoRegistry, servedRepos } from "./repo-registry";
import { type PollResult, pollOnce, type WatchDeps } from "./watch";

export interface RepoSource {
  readonly deps: WatchDeps;
  readonly own?: Partial<FactoryConfig>;
}

export type PollRepos = Record<string, PollResult | { readonly error: string }>;

export async function pollRegistry(
  registry: RepoRegistry,
  sourceFor: (entry: RepoEntry) => RepoSource | Promise<RepoSource>,
  inFlight: Map<string, Set<number>> = new Map(),
): Promise<PollRepos> {
  const out: PollRepos = {};
  for (const entry of servedRepos(registry)) {
    try {
      const { deps, own } = await sourceFor(entry);
      const claimed = inFlight.get(entry.repo) ?? new Set<number>();
      inFlight.set(entry.repo, claimed);
      out[entry.repo] = await pollOnce(deps, configForEntry(entry, own), claimed);
    } catch (err) {
      out[entry.repo] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return out;
}
