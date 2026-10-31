// JSON Schema for the session shapes in src/ports/session.ts, hand-written so a field an adapter
// invents fails validation, and the map from a run's status to a session state.

import type { SessionState } from "../ports/session";
import { fitsSchema, type JsonSchema } from "../schemas";
import type { RunStatus } from "../state";

export const SESSION_STATES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const satisfies readonly SessionState[];

// The one place objects are closed, so an invented field fails in every shape.
const closed = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const str: JsonSchema = { type: "string" };
const state: JsonSchema = { type: "string", enum: [...SESSION_STATES] };
const REF = closed({ runtime: str, connection: str, externalId: str }, ["runtime", "connection", "externalId"]);

export const SESSION_SCHEMA = closed(
  {
    ref: REF,
    title: { type: "string", maxLength: 200 },
    state,
    repo: str,
    issue: { type: "integer" },
    stage: str,
    startedAt: str,
    updatedAt: str,
    link: str,
    prUrl: str,
    branch: str,
    needsYou: { type: "string", maxLength: 200 },
    costUsd: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] },
    tokensIn: { type: "integer", minimum: 0 },
    tokensOut: { type: "integer", minimum: 0 },
    model: str,
    configHash: { anyOf: [str, { type: "null" }] },
  },
  ["ref", "title", "state", "startedAt", "updatedAt"],
);

export const SESSION_EVENT_SCHEMA = closed(
  {
    ref: REF,
    at: str,
    kind: { type: "string", enum: ["state", "stage", "approval", "cost", "link", "note", "error"] },
    state,
    stage: str,
    text: { type: "string", maxLength: 280 },
    costUsd: { type: "number", minimum: 0 },
  },
  ["ref", "at", "kind"],
);

// fitsSchema checks one node's type; this walks objects for required keys, unknown keys and
// string length, which fitsSchema leaves alone.
export function schemaProblem(schema: JsonSchema, value: unknown, path = "$"): string | undefined {
  if (!fitsSchema(schema, value)) return `${path} has the wrong type or value`;
  if (typeof value === "string" && typeof schema.maxLength === "number" && value.length > schema.maxLength)
    return `${path} is longer than ${schema.maxLength} characters`;
  if (schema.type !== "object" || typeof value !== "object" || value === null) return undefined;
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const obj = value as Record<string, unknown>;
  for (const k of (schema.required ?? []) as string[]) if (obj[k] === undefined) return `${path}.${k} is required`;
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const prop = props[k];
    if (!prop) {
      if (schema.additionalProperties === false) return `${path}.${k} is not a known field`;
      continue;
    }
    const p = schemaProblem(prop, v, `${path}.${k}`);
    if (p) return p;
  }
  return undefined;
}

export const fromRunStatus = (status: RunStatus): SessionState => RUN_STATE[status];

const RUN_STATE: Record<RunStatus, SessionState> = {
  running: "running",
  verifying: "running",
  "needs-info": "waiting",
  "awaiting-approval": "waiting",
  "needs-human": "waiting",
  shipped: "succeeded",
  rejected: "failed",
  failed: "failed",
  cancelled: "cancelled",
};
