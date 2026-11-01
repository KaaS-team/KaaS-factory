// The agent-session contract (mission control): what any place an agent runs offers so one row can
// show it. An adapter that cannot do a verb says so in its caps, and the verb throws
// SessionUnsupported instead of pretending, the rule src/ports/sandbox.ts follows.
// No transcript, log body or tool output lives in these shapes; `link` points at the agent's own view.

export type SessionState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown";

export interface SessionRef {
  // The adapter kind: factory, claude-code, cursor, codex, acp, otlp, webhook.
  readonly runtime: string;
  // The name of a configured connection, never a host or token.
  readonly connection: string;
  readonly externalId: string;
}

export interface AgentSession {
  ref: SessionRef;
  // At most 200 characters.
  title: string;
  state: SessionState;
  repo?: string;
  issue?: number;
  stage?: string;
  startedAt: string;
  updatedAt: string;
  link?: string;
  prUrl?: string;
  branch?: string;
  // Why a human is needed, at most 200 characters.
  needsYou?: string;
  // null means not reported, never zero.
  costUsd?: number | null;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
  configHash?: string | null;
}

export type SessionEventKind = "state" | "stage" | "approval" | "cost" | "link" | "note" | "error";

export interface SessionEvent {
  ref: SessionRef;
  at: string;
  kind: SessionEventKind;
  state?: SessionState;
  stage?: string;
  // A one-line summary, at most 280 characters.
  text?: string;
  costUsd?: number;
}

export interface SessionCaps {
  readonly list: boolean;
  readonly events: "push" | "poll" | "none";
  readonly cancel: boolean;
  readonly followUp: boolean;
  readonly deepLink: boolean;
}

export interface SessionAdapter {
  readonly kind: string;
  readonly caps: SessionCaps;
  list(signal?: AbortSignal): Promise<AgentSession[]>;
  get(ref: SessionRef, signal?: AbortSignal): Promise<AgentSession | undefined>;
  // Resolves with the adapter's own cursor so a restart resumes from it.
  follow(
    ref: SessionRef,
    after: string | undefined,
    onEvent: (e: SessionEvent) => void,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  link(ref: SessionRef): string | undefined;
  cancel(ref: SessionRef): Promise<void>;
  followUp(ref: SessionRef, text: string): Promise<void>;
}

export class SessionUnsupported extends Error {}
