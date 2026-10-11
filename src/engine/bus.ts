// The event bus (v4.0). emit() writes the CloudEvent to the SQLite outbox,
// queues one delivery per matching sink, and tells in-process subscribers.
// deliver() POSTs due deliveries, signed with the sink's secret, and retries a
// failure with exponential backoff until it lands or runs out of attempts.
// Inbound events (POST /events) land in the same table; drainInbound() hands
// them to the same subscribers. Emitting never throws into the engine: a run
// must not fail because a webhook sink is down.

import { EVENT_SIGNATURE_HEADER, makeEvent, signEvent, type CloudEvent, type EventType, type FactoryEventType } from "../core/event";
import type { EventSink } from "../config";
import type { BusDeliveryRow, BusEventRow } from "../state";

// The FactoryState methods the bus uses, so a test can hand it any store.
export interface BusStore {
  recordBusEvent(e: BusEventRow): boolean;
  busEvent(id: string): BusEventRow | undefined;
  queueBusDelivery(eventId: string, sink: string, at?: Date): void;
  requeueBusDeliveries(eventId: string, at?: Date): number;
  dueBusDeliveries(now?: Date): BusDeliveryRow[];
  markBusDelivery(id: number, d: { status: "pending" | "delivered" | "dead"; attempts: number; nextAt: Date; error?: string }, at?: Date): void;
  unhandledInbound(): BusEventRow[];
  markBusHandled(id: string, at?: Date): void;
}

export type Subscriber = (event: CloudEvent) => void | Promise<void>;

export interface BusOptions {
  readonly store: BusStore;
  readonly sinks: readonly EventSink[];
  // CloudEvents `source`: which factory emitted it, e.g. "factory/owner/repo".
  readonly source: string;
  // Read by variable name at send time; defaults to process.env.
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly baseDelayMs?: number;
  readonly maxAttempts?: number;
  // false: emit() only queues, and the caller runs deliver() (tests, the CLI).
  readonly autoDeliver?: boolean;
  readonly log?: (line: string) => void;
}

export const BUS_BASE_DELAY_MS = 2_000;
export const BUS_MAX_ATTEMPTS = 8;
const BUS_MAX_DELAY_MS = 60 * 60_000;
const SEND_TIMEOUT_MS = 10_000;

// Attempt n (1-based) failed: wait base * 2^(n-1), capped at an hour.
export function backoffMs(attempts: number, baseMs = BUS_BASE_DELAY_MS): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempts - 1), BUS_MAX_DELAY_MS);
}

export function rowToEvent(r: BusEventRow): CloudEvent {
  return {
    specversion: "1.0",
    id: r.id,
    source: r.source,
    type: r.type,
    ...(r.subject !== null ? { subject: r.subject } : {}),
    time: r.time,
    data: JSON.parse(r.data) as unknown,
  };
}

function sinkWants(sink: EventSink, type: string): boolean {
  return sink.types === undefined || sink.types.includes(type);
}

export class EventBus {
  private readonly subs = new Map<string, Set<Subscriber>>();
  private delivering: Promise<number> | null = null;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly send: (url: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: BusOptions) {
    this.env = opts.env ?? process.env;
    this.send = opts.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) }));
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line) => console.error(line));
  }

  // "*" hears every event. Returns the unsubscribe.
  subscribe(type: string, fn: Subscriber): () => void {
    const set = this.subs.get(type) ?? new Set();
    set.add(fn);
    this.subs.set(type, set);
    return () => set.delete(fn);
  }

  // The engine passes a FactoryEventType through emitEvent; a minion passes its `emit:` type.
  emit(type: EventType, data: unknown, subject?: string): CloudEvent {
    const event = makeEvent({ id: this.opts.newId?.() ?? crypto.randomUUID(), source: this.opts.source, type, subject, time: this.now(), data });
    this.opts.store.recordBusEvent({
      id: event.id,
      direction: "out",
      type: event.type,
      source: event.source,
      subject: event.subject ?? null,
      time: event.time,
      data: JSON.stringify(event.data),
      handled_at: event.time,
    });
    for (const sink of this.opts.sinks) if (sinkWants(sink, type)) this.opts.store.queueBusDelivery(event.id, sink.url, this.now());
    this.publish(event);
    if (this.opts.autoDeliver !== false) void this.deliver();
    return event;
  }

  // Tell subscribers. A throwing or rejecting subscriber is logged, never rethrown.
  publish(event: CloudEvent): void {
    for (const fn of [...(this.subs.get(event.type) ?? []), ...(this.subs.get("*") ?? [])]) {
      try {
        void Promise.resolve(fn(event)).catch((e) => this.log(`event subscriber for ${event.type} failed: ${String(e)}`));
      } catch (e) {
        this.log(`event subscriber for ${event.type} failed: ${String(e)}`);
      }
    }
  }

  // Inbound rows POST /events stored and nobody has heard yet, oldest first.
  drainInbound(): number {
    const rows = this.opts.store.unhandledInbound();
    for (const row of rows) {
      this.opts.store.markBusHandled(row.id, this.now());
      this.publish(rowToEvent(row));
    }
    return rows.length;
  }

  // Put an event's deliveries back to pending, due now; for `factory events replay`.
  replay(id: string): number {
    const row = this.opts.store.busEvent(id);
    if (!row) return 0;
    const sinks = this.opts.sinks.filter((s) => sinkWants(s, row.type));
    for (const s of sinks) this.opts.store.queueBusDelivery(id, s.url, this.now());
    return this.opts.store.requeueBusDeliveries(id, this.now());
  }

  // One pass over due deliveries; concurrent callers share the pass in flight.
  deliver(): Promise<number> {
    if (this.delivering) return this.delivering;
    this.delivering = this.deliverDue().finally(() => {
      this.delivering = null;
    });
    return this.delivering;
  }

  private async deliverDue(): Promise<number> {
    let delivered = 0;
    for (const d of this.opts.store.dueBusDeliveries(this.now())) {
      if (await this.attempt(d)) delivered++;
    }
    return delivered;
  }

  private async attempt(d: BusDeliveryRow): Promise<boolean> {
    const attempts = d.attempts + 1;
    const sink = this.opts.sinks.find((s) => s.url === d.sink);
    const row = this.opts.store.busEvent(d.event_id);
    if (!sink || !row) {
      this.opts.store.markBusDelivery(d.id, { status: "dead", attempts, nextAt: this.now(), error: !sink ? "sink no longer configured" : "event row missing" });
      return false;
    }
    let error: string;
    const secret = this.env[sink.secretEnv];
    if (!secret) error = `${sink.secretEnv} is unset`;
    else {
      const body = JSON.stringify(rowToEvent(row));
      try {
        const res = await this.send(sink.url, {
          method: "POST",
          headers: { "content-type": "application/cloudevents+json", [EVENT_SIGNATURE_HEADER]: signEvent(secret, body) },
          body,
        });
        if (res.ok) {
          this.opts.store.markBusDelivery(d.id, { status: "delivered", attempts, nextAt: this.now() }, this.now());
          return true;
        }
        error = `HTTP ${res.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    const dead = attempts >= (this.opts.maxAttempts ?? BUS_MAX_ATTEMPTS);
    const nextAt = new Date(this.now().getTime() + backoffMs(attempts, this.opts.baseDelayMs));
    this.opts.store.markBusDelivery(d.id, { status: dead ? "dead" : "pending", attempts, nextAt, error });
    this.log(`event ${row.type} ${row.id} to ${sink.url}: attempt ${attempts} failed (${error})${dead ? ", giving up" : ""}`);
    return false;
  }
}

// The engine's one way to emit: no bus is a no-op, and a failing store is
// logged, never thrown, so an outbox problem cannot fail a run.
export function emitEvent(bus: EventBus | undefined, type: FactoryEventType, data: unknown, subject?: string): void {
  if (!bus) return;
  try {
    bus.emit(type, data, subject);
  } catch (e) {
    console.error(`emit ${type} failed: ${String(e)}`);
  }
}
