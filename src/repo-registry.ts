// The repos one machine serves, listed in machine.json under "repos". Adding a repo is one entry
// there: a repo's own settings still come from its .factory/config.json, so an entry names only
// what the machine decides (whether it is served, its lease cap, its poll cadence).

import type { FactoryConfig } from "./config";
import { mergeConfig } from "./config";

export interface RepoEntry {
  readonly repo: string;
  // False keeps the entry listed but unserved.
  readonly enabled?: boolean;
  // Caps this repo's leases below the machine's slots; the repo's own concurrency still applies.
  readonly concurrency?: number;
  readonly pollIntervalSeconds?: number;
  // Marks the repo that holds the factory itself; at most one entry.
  readonly factory?: boolean;
}

export type RepoRegistry = readonly RepoEntry[];

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KEYS = new Set(["repo", "enabled", "concurrency", "pollIntervalSeconds", "factory"]);

const posInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1;

export function registryProblems(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw)) return [`${where}: "repos" must be a list of entries, got ${JSON.stringify(raw)}`];
  const problems: string[] = [];
  const seen = new Set<string>();
  let factories = 0;
  raw.forEach((e, i) => {
    const at = `${where}: repos[${i}]`;
    if (typeof e !== "object" || e === null || Array.isArray(e)) return void problems.push(`${at} must be an object`);
    const entry = e as Record<string, unknown>;
    if (typeof entry.repo !== "string" || !SLUG.test(entry.repo))
      problems.push(`${at}: "repo" must be owner/name, got ${JSON.stringify(entry.repo)}`);
    else if (seen.has(entry.repo)) problems.push(`${at}: "${entry.repo}" is listed twice`);
    else seen.add(entry.repo);
    for (const k of Object.keys(entry)) if (!KEYS.has(k)) problems.push(`${at}: unknown key "${k}"`);
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
      problems.push(`${at}: "enabled" must be a boolean`);
    for (const k of ["concurrency", "pollIntervalSeconds"])
      if (entry[k] !== undefined && !posInt(entry[k])) problems.push(`${at}: "${k}" must be a positive integer`);
    if (entry.factory !== undefined && typeof entry.factory !== "boolean")
      problems.push(`${at}: "factory" must be a boolean`);
    if (entry.factory === true) factories++;
  });
  if (factories > 1) problems.push(`${where}: only one repo may set "factory": true, found ${factories}`);
  return problems;
}

export const servedRepos = (registry: RepoRegistry): RepoEntry[] => registry.filter((e) => e.enabled !== false);

export const factoryRepo = (registry: RepoRegistry): RepoEntry | undefined => registry.find((e) => e.factory === true);

// The entry's caps laid over a repo's own config: a cap only ever lowers what the repo asked for.
export function configForEntry(entry: RepoEntry, own: Partial<FactoryConfig> = {}): FactoryConfig {
  const merged = mergeConfig({ ...own, repo: entry.repo });
  return {
    ...merged,
    concurrency: Math.min(merged.concurrency, entry.concurrency ?? merged.concurrency),
    pollIntervalSeconds: entry.pollIntervalSeconds ?? merged.pollIntervalSeconds,
  };
}
