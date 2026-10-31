// The live feed: a ring of the last 1000 events with ids, and the SSE response that replays from one.

import type { LiveEvent, LiveEventType } from "./events";

export const RING_SIZE = 1000;
export const HEARTBEAT_MS = 15_000;

export type Since = { events: LiveEvent[]; reset?: undefined } | { reset: boolean; events?: undefined };

export class LiveFeed {
  private readonly ring: LiveEvent[] = [];
  private last = 0;
  private readonly listeners = new Set<(e: LiveEvent) => void>();

  push(type: LiveEventType, data: Record<string, unknown>): LiveEvent {
    const event: LiveEvent = { id: ++this.last, type, data };
    this.ring.push(event);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    for (const fn of this.listeners) fn(event);
    return event;
  }

  /** The events after `lastId`, or a reset when `lastId` fell out of the ring or never existed. */
  since(lastId: number): Since {
    const oldest = this.last - this.ring.length;
    if (!Number.isInteger(lastId) || lastId < oldest || lastId > this.last) return { reset: true };
    return { events: this.ring.filter((e) => e.id > lastId) };
  }

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}

function frame(e: LiveEvent): string {
  return `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

export function sseResponse(
  feed: LiveFeed,
  lastEventId: number | undefined,
  signal: AbortSignal,
  heartbeatMs = HEARTBEAT_MS,
): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(enc.encode(text));
        } catch {
          cleanup();
        }
      };
      // Subscribe before replaying so an event pushed in between is not lost; ids above `sent` are new.
      let sent = lastEventId ?? 0;
      const live = (e: LiveEvent) => {
        if (e.id <= sent) return;
        sent = e.id;
        send(frame(e));
      };
      const unsubscribe = feed.subscribe(live);
      const timer = setInterval(() => send(": heartbeat\n\n"), heartbeatMs);
      cleanup = () => {
        clearInterval(timer);
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      };
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) return onAbort();
      if (lastEventId !== undefined) {
        const missed = feed.since(lastEventId);
        if (missed.reset) {
          // The client's cursor is gone: tell it to reload, then stream only what is pushed from now on.
          send("event: reset\ndata: {}\n\n");
          sent = 0;
        } else for (const e of missed.events ?? []) live(e);
      }
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
