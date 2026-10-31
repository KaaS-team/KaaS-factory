// An in-memory SessionAdapter for tests of later slices; its caps are settable so a test can make
// it honest or dishonest.

import {
  type AgentSession,
  type SessionAdapter,
  type SessionCaps,
  type SessionEvent,
  type SessionRef,
  SessionUnsupported,
} from "../ports/session";

export interface FakeOptions {
  kind?: string;
  caps?: Partial<SessionCaps>;
  events?: SessionEvent[];
  // Make a verb throw SessionUnsupported even when its cap says true (a dishonest adapter).
  lie?: Partial<Record<"cancel" | "followUp" | "list", boolean>>;
}

const DEFAULT_CAPS: SessionCaps = { list: true, events: "poll", cancel: false, followUp: false, deepLink: true };

export function fakeAdapter(rows: AgentSession[], opts: FakeOptions = {}): SessionAdapter {
  const caps: SessionCaps = { ...DEFAULT_CAPS, ...opts.caps };
  const need = (ok: boolean, verb: string) => {
    if (!ok) throw new SessionUnsupported(`${verb} is not supported`);
  };
  return {
    kind: opts.kind ?? "fake",
    caps,
    async list() {
      need(caps.list && !opts.lie?.list, "list");
      return rows;
    },
    async get(ref) {
      return rows.find((r) => r.ref.externalId === ref.externalId);
    },
    async follow(_ref, after, onEvent, signal) {
      need(caps.events !== "none", "follow");
      if (signal?.aborted) return after;
      for (const e of opts.events ?? []) onEvent(e);
      return String(opts.events?.length ?? 0);
    },
    link(ref) {
      return caps.deepLink ? rows.find((r) => r.ref.externalId === ref.externalId)?.link : undefined;
    },
    async cancel() {
      need(caps.cancel && !opts.lie?.cancel, "cancel");
    },
    async followUp() {
      need(caps.followUp && !opts.lie?.followUp, "followUp");
    },
  };
}
