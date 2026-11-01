// The one route table. The server (core.ts), the client (client.ts), openapi.json and the contract
// test all read ROUTES, so they cannot drift. Response schemas mirror Run, RunEvent and spendSummary in src/state.ts.

import type { JsonSchema } from "../schemas";

export interface ApiRoute {
  id: string;
  method: "GET" | "POST";
  /** `:name` segments are path parameters; query parameters are described by `req`. */
  path: string;
  auth: "none" | "token";
  /** Query parameters, as an object schema. */
  req?: JsonSchema;
  res: JsonSchema;
  /** The response is a Server-Sent Events stream, not JSON. */
  sse?: true;
}

const str: JsonSchema = { type: "string" };
const int: JsonSchema = { type: "integer" };
const num: JsonSchema = { type: "number" };
const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: "null" }] });

// Copied from `Stage` and `RunStatus` in src/state.ts; tests/api-routes.test.ts compares them.
export const STAGE_ENUM = ["triage", "plan", "build", "verify", "pr"];
export const RUN_STATUS_ENUM = [
  "running",
  "needs-info",
  "awaiting-approval",
  "verifying",
  "rejected",
  "shipped",
  "failed",
  "needs-human",
  "cancelled",
];

function object(properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required };
}

export const RUN_SCHEMA: JsonSchema = object({
  id: int,
  issue: int,
  repo: str,
  title: str,
  stage: { enum: STAGE_ENUM },
  status: { enum: RUN_STATUS_ENUM },
  started_at: str,
  updated_at: str,
  tool_calls: int,
  tokens_in: int,
  tokens_out: int,
  cost_usd: { type: "number" },
  gate_line: nullable(str),
  pr_url: nullable(str),
  reason: nullable(str),
  status_comment_id: nullable(int),
  config_hash: nullable(str),
});

export const RUN_EVENT_SCHEMA: JsonSchema = object({
  id: int,
  run_id: int,
  ts: str,
  stage: { enum: STAGE_ENUM },
  kind: str,
  text: str,
});

const SPEND_SCHEMA: JsonSchema = object({
  since: str,
  repos: {
    type: "array",
    items: object({ repo: str, costUsd: { type: "number" }, unreportedRuns: int }),
  },
});

export const ROUTES: readonly ApiRoute[] = [
  { id: "health", method: "GET", path: "/api/health", auth: "none", res: object({ ok: { type: "boolean" } }) },
  {
    id: "repos.list",
    method: "GET",
    path: "/api/repos",
    auth: "token",
    res: object({ repos: { type: "array", items: str } }),
  },
  {
    id: "runs.list",
    method: "GET",
    path: "/api/runs",
    auth: "token",
    req: object({ repo: str }, []),
    res: object({ runs: { type: "array", items: RUN_SCHEMA } }),
  },
  {
    id: "runs.get",
    method: "GET",
    path: "/api/runs/:repo/:issue",
    auth: "token",
    res: object({ run: RUN_SCHEMA }),
  },
  {
    id: "runs.events",
    method: "GET",
    path: "/api/runs/:repo/:issue/events",
    auth: "token",
    req: object({ after: int }, []),
    res: object({ events: { type: "array", items: RUN_EVENT_SCHEMA } }),
  },
  {
    id: "spend.get",
    method: "GET",
    path: "/api/spend",
    auth: "token",
    req: object({ since: str }, []),
    res: SPEND_SCHEMA,
  },
  {
    id: "metrics.get",
    method: "GET",
    path: "/api/metrics",
    auth: "token",
    res: object({
      metrics: object({ mergeRate: num, costPerMergedChange: num, judgeVetoRate: num }, []),
    }),
  },
  { id: "stream", method: "GET", path: "/api/events", auth: "token", res: { type: "string" }, sse: true },
];
