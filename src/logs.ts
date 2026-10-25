// Ported from owainlewis/assembler@7cac671 src/runs.ts:93-140 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the source is the run's events in the state DB (keyset on id) instead of log files, so there is no path-escape or split-UTF-8 handling; the stage filter, NDJSON shape, follow loop and "no step matching" error are kept.

import { plain } from "./display";
import type { FactoryState, Run, RunStatus } from "./state";

const ACTIVE: readonly RunStatus[] = ["running", "verifying"];
const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

export interface LogOptions {
  follow?: boolean;
  stage?: string;
  json?: boolean;
  signal?: AbortSignal;
  pollMs?: number;
}

export async function streamLogs(
  state: FactoryState,
  repo: string,
  issue: number,
  options: LogOptions,
  print: (value: string) => void = (value) => process.stdout.write(value),
): Promise<void> {
  let after = 0;
  let lastStage = "";
  let matched = false;
  while (!options.signal?.aborted) {
    const run: Run | undefined = state.getRun(repo, issue);
    if (!run) throw new Error(`No run recorded for issue #${issue}`);
    for (;;) {
      const events = state.listEvents(run.id, { after, limit: 200 });
      if (!events.length) break;
      for (const event of events) {
        after = event.id;
        if (options.stage && event.stage !== options.stage) continue;
        matched = true;
        const text = plain(event.text);
        if (options.json) print(`${JSON.stringify({ issue, stage: event.stage, kind: event.kind, text })}\n`);
        else {
          if (lastStage !== event.stage) print(`\n--- ${event.stage} ---\n`);
          print(`${text}\n`);
          lastStage = event.stage;
        }
      }
    }
    if (options.stage && !matched && (!options.follow || !ACTIVE.includes(run.status))) {
      throw new Error(`No stage matching ${options.stage}`);
    }
    if (!options.follow || !ACTIVE.includes(run.status)) return;
    await delay(options.pollMs ?? 250, options.signal);
  }
}
