// `factory learn --export`: the state rows as v1 JSONL, one object per line, for tooling outside the factory.

import { existsSync, writeFileSync } from "node:fs";
import { UsageError } from "./cli-output";
import { loadMachineConfig } from "./machine";
import { defaultStatePath } from "./paths";
import { servedRepos } from "./repo-registry";
import { FactoryState } from "./state";

const PAGE = 200;

const line = (type: "run" | "stage" | "retro", row: object): string => JSON.stringify({ v: 1, type, ...row });

// `since` is compared as an ISO string against started_at (runs, stages) and created_at (retros).
export function* exportLearning(state: FactoryState, repo: string, since?: string): Generator<string> {
  const keep = (at: string): boolean => since === undefined || at >= since;
  for (const run of state.listRuns(repo)) if (keep(run.started_at)) yield line("run", run);
  for (let after = 0; ; ) {
    const page = state.listStageRuns(repo, { after, limit: PAGE });
    for (const s of page) if (keep(s.started_at)) yield line("stage", s);
    if (page.length < PAGE) break;
    after = page[page.length - 1]!.id;
  }
  const retros = state.listRetros(repo, Number.MAX_SAFE_INTEGER).reverse();
  for (const r of retros) if (keep(r.created_at)) yield line("retro", r);
}

// `--since` goes through Date.parse so any date the user writes compares against the stored ISO stamps.
export function runExport(dbPath: string, repo: string, target: string | undefined, since: string | undefined): void {
  if (!target) throw new UsageError("learn: --export needs a file, or - for stdout");
  const ms = since === undefined ? undefined : Date.parse(since);
  if (ms !== undefined && Number.isNaN(ms)) throw new UsageError(`learn: --since "${since}" is not a date`);
  const state = new FactoryState(dbPath);
  const lines = [...exportLearning(state, repo, ms === undefined ? undefined : new Date(ms).toISOString())];
  state.close();
  const text = lines.map((l) => `${l}\n`).join("");
  if (target === "-") process.stdout.write(text);
  else writeFileSync(target, text);
}

// `--all`: every served repo in the machine registry, one JSONL. A repo with no state file is
// skipped, and each file opens read-only, so the export never creates or migrates a database.
export function exportAll(repos: readonly string[], dbPathFor: (repo: string) => string, since?: string): string[] {
  const lines: string[] = [];
  for (const repo of repos) {
    const path = dbPathFor(repo);
    if (!existsSync(path)) continue;
    const state = new FactoryState(path, { readonly: true });
    try {
      lines.push(...exportLearning(state, repo, since));
    } finally {
      state.close();
    }
  }
  return lines;
}

export function runExportAll(
  repos: readonly string[],
  dbPathFor: (repo: string) => string,
  target: string | undefined,
  since: string | undefined,
): void {
  if (!target) throw new UsageError("learn: --export needs a file, or - for stdout");
  const ms = since === undefined ? undefined : Date.parse(since);
  if (ms !== undefined && Number.isNaN(ms)) throw new UsageError(`learn: --since "${since}" is not a date`);
  const text = exportAll(repos, dbPathFor, ms === undefined ? undefined : new Date(ms).toISOString())
    .map((l) => `${l}\n`)
    .join("");
  if (target === "-") process.stdout.write(text);
  else writeFileSync(target, text);
}

// `learn --export --all`: the registered repos come from machine.json, each repo's own state file.
export function runExportRegistry(target: string | undefined, since: string | undefined): void {
  const repos = servedRepos(loadMachineConfig().repos ?? []).map((e) => e.repo);
  if (repos.length === 0) throw new UsageError("learn: --all needs repos listed in machine.json");
  runExportAll(repos, (r) => defaultStatePath(process.env, r), target, since);
}
