// The factory's event envelope: CloudEvents 1.0 structured JSON, one catalogue
// of every type the factory emits or accepts, and the HMAC that signs a body on
// the way out and checks it on the way in. Pure: no clock, no I/O, no node:
// imports (the hexagon rule), so the HMAC uses Bun's global CryptoHasher.

// Every type the factory itself emits. A structural test greps src/ for each
// emit call and fails on a type missing here.
export const FACTORY_EVENTS = [
  "factory.issue.ready",
  "factory.step.started",
  "factory.step.completed",
  "factory.step.failed",
  "factory.issue.parked",
  "factory.pr.opened",
  "factory.pr.merged",
  "factory.run.completed",
  "factory.minion.completed",
] as const;

// Types other KaaS apps emit that POST /events accepts. Anything else is ignored.
export const EXTERNAL_EVENTS = [
  "tasks.task.ready",
  "tasks.task.updated",
  "wiki.page.updated",
  "wiki.question.unanswered",
  "decisions.decision.proposed",
  "decisions.conflict.detected",
  "skills.skill.proposed",
  "skills.skill.promoted",
  "audit.report.completed",
] as const;

export const EVENT_TYPES = [...FACTORY_EVENTS, ...EXTERNAL_EVENTS] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type FactoryEventType = (typeof FACTORY_EVENTS)[number];

const KNOWN: ReadonlySet<string> = new Set(EVENT_TYPES);
export function isEventType(t: unknown): t is EventType {
  return typeof t === "string" && KNOWN.has(t);
}

// Inbound accepts only other apps' types: a factory.* event arriving from
// outside would let a caller fake a merge or a run ending.
const EXTERNAL: ReadonlySet<string> = new Set(EXTERNAL_EVENTS);
export function isExternalEventType(t: unknown): boolean {
  return typeof t === "string" && EXTERNAL.has(t);
}

export interface CloudEvent {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly subject?: string;
  readonly time: string;
  readonly data: unknown;
}

export function makeEvent(e: { id: string; source: string; type: string; subject?: string; time: Date; data: unknown }): CloudEvent {
  return {
    specversion: "1.0",
    id: e.id,
    source: e.source,
    type: e.type,
    ...(e.subject !== undefined ? { subject: e.subject } : {}),
    time: e.time.toISOString(),
    data: e.data ?? null,
  };
}

// Checks the envelope shape only; whether the type is known is the caller's call.
export function parseEvent(raw: unknown): { ok: true; event: CloudEvent } | { ok: false; problem: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "event must be a JSON object" };
  const r = raw as Record<string, unknown>;
  if (r.specversion !== "1.0") return { ok: false, problem: 'specversion must be "1.0"' };
  for (const k of ["id", "source", "type", "time"] as const) {
    if (typeof r[k] !== "string" || (r[k] as string).length === 0) return { ok: false, problem: `${k} must be a non-empty string` };
  }
  if ((r.id as string).length > 200) return { ok: false, problem: "id is longer than 200 characters" };
  if (Number.isNaN(Date.parse(r.time as string))) return { ok: false, problem: "time must be an RFC 3339 timestamp" };
  if (r.subject !== undefined && typeof r.subject !== "string") return { ok: false, problem: "subject must be a string" };
  return {
    ok: true,
    event: {
      specversion: "1.0",
      id: r.id as string,
      source: r.source as string,
      type: r.type as string,
      ...(typeof r.subject === "string" ? { subject: r.subject } : {}),
      time: r.time as string,
      data: r.data ?? null,
    },
  };
}

export const EVENT_SIGNATURE_HEADER = "x-kaas-signature";

// `sha256=<hex>` of HMAC-SHA256(secret, body), the same shape GitHub uses.
export function signEvent(secret: string, body: string): string {
  const h = new Bun.CryptoHasher("sha256", secret);
  h.update(body);
  return `sha256=${h.digest("hex")}`;
}

// Constant time over equal lengths; an empty secret never verifies.
export function verifyEvent(secret: string, body: string, header: string | null | undefined): boolean {
  if (!secret || !header) return false;
  const want = signEvent(secret, body);
  if (header.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}
