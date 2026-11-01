// The live event contract: what `GET /api/events` (SSE) can carry, with a payload schema for each.
// Declared here once; the contract test validates every pushed event against these.

import type { JsonSchema } from "../schemas";

const str: JsonSchema = { type: "string" };
const int: JsonSchema = { type: "integer" };
const STAGES = ["triage", "plan", "build", "verify", "pr"];
const stage: JsonSchema = { enum: STAGES };
const status: JsonSchema = { type: "string" };

function payload(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export const LIVE_EVENTS = {
  "run.updated": payload({ repo: str, issue: int, stage, status, updated_at: str }),
  "stage.started": payload({ repo: str, issue: int, stage }),
  "stage.finished": payload({ repo: str, issue: int, stage, status }),
  "log.appended": payload({ repo: str, issue: int, id: int, ts: str, stage, kind: str, text: str }),
  // Declared for the contract; nothing pushes these yet.
  "inbox.changed": payload({ repo: str }),
  "message.queued": payload({ repo: str, issue: int }),
  "repo.changed": payload({ repo: str }),
} as const satisfies Record<string, JsonSchema>;

export type LiveEventType = keyof typeof LIVE_EVENTS;
export type LiveEvent = { id: number; type: LiveEventType; data: Record<string, unknown> };
