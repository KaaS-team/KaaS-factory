// `factory learn --export`: the state rows as v1 JSONL, one object per line, for tooling outside the factory.

import { writeFileSync } from "node:fs";
import { UsageError } from "./cli-output";
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
