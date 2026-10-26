// `factory events tail [--follow]`: the outbox and inbox, newest last. With follow it keeps polling
// the state db by seq, so a watcher's events (in another process) show up as they are recorded.

import type { BusDeliveryRow, BusEventRow } from "./state";

export interface TailStore {
  busEvents(limit?: number, after?: number): BusEventRow[];
  busDeliveries(id: string): BusDeliveryRow[];
}

export interface TailOptions {
  readonly limit?: number;
  readonly follow?: boolean;
  readonly json?: boolean;
  readonly signal?: AbortSignal;
  readonly intervalMs?: number;
  readonly write?: (line: string) => void;
}

export function formatEvent(r: BusEventRow, deliveries: readonly BusDeliveryRow[], json = false): string {
  if (json) return JSON.stringify({ ...r, data: JSON.parse(r.data), deliveries });
  const sent = deliveries.map((d) => `  [${d.status} ${d.sink}]`).join("");
  return `${r.time}  ${r.direction === "in" ? "<-" : "->"}  ${r.type}  ${r.id}${r.subject ? `  ${r.subject}` : ""}${sent}`;
}

// Resolves when the signal aborts (follow) or after the first page (no follow).
export async function tailEvents(state: TailStore, opts: TailOptions = {}): Promise<void> {
  const write = opts.write ?? ((line: string) => console.log(line));
  let after = 0;
  let limit = opts.limit ?? 50;
  for (;;) {
    for (const r of state.busEvents(limit, after)) {
      write(formatEvent(r, state.busDeliveries(r.id), opts.json));
      after = Math.max(after, r.seq ?? after);
    }
    if (!opts.follow || opts.signal?.aborted) return;
    limit = 1000;
    await new Promise<void>((done) => {
      const t = setTimeout(done, opts.intervalMs ?? 1000);
      opts.signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
    });
    if (opts.signal?.aborted) return;
  }
}
