// One OpenTelemetry trace per run, in OTLP/JSON: a root span for the run and one `invoke_agent` span
// per stage, carrying the GenAI semantic convention's gen_ai.* attributes for tokens, plus the cost.
// Sent to OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces, so any OTLP collector (Langfuse, Honeycomb) takes it.

import { createHash } from "node:crypto";
import type { StageRun } from "../state";

export const OTEL_ENV = { endpoint: "OTEL_EXPORTER_OTLP_ENDPOINT", headers: "OTEL_EXPORTER_OTLP_HEADERS" } as const;

type Value = { stringValue: string } | { intValue: string } | { doubleValue: number };
interface Attr {
  key: string;
  value: Value;
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status: { code: number };
}

const attr = (key: string, v: string | number): Attr => ({
  key,
  value:
    typeof v === "string" ? { stringValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
});
const nanos = (iso: string) => `${BigInt(Date.parse(iso)) * 1_000_000n}`;
// Ids from the run's own facts, so exporting the same run twice gives the same trace.
const hex = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n);

export function runTrace(run: { repo: string; issue: number; outcome: string }, stages: readonly StageRun[]) {
  if (!stages.length) return undefined;
  const first = stages[0]!;
  const traceId = hex(`${run.repo}#${run.issue}#${first.id}`, 32);
  const rootId = hex(`${traceId}/root`, 16);
  const end = stages.reduce((a, s) => (s.finished_at > a ? s.finished_at : a), first.finished_at);
  const sum = (f: (s: StageRun) => number) => stages.reduce((a, s) => a + f(s), 0);
  const spans: OtlpSpan[] = [
    {
      traceId,
      spanId: rootId,
      name: `factory.run issue/${run.issue}`,
      kind: 1,
      startTimeUnixNano: nanos(first.started_at),
      endTimeUnixNano: nanos(end),
      attributes: [
        attr("factory.repo", run.repo),
        attr("factory.issue", run.issue),
        attr("factory.outcome", run.outcome),
        attr(
          "gen_ai.usage.input_tokens",
          sum((s) => s.tokens_in),
        ),
        attr(
          "gen_ai.usage.output_tokens",
          sum((s) => s.tokens_out),
        ),
        attr(
          "factory.cost_usd",
          sum((s) => s.cost_usd ?? 0),
        ),
      ],
      status: { code: run.outcome === "failed" ? 2 : 1 },
    },
    ...stages.map((s) => ({
      traceId,
      spanId: hex(`${traceId}/${s.id}`, 16),
      parentSpanId: rootId,
      name: `invoke_agent ${s.stage}`,
      kind: 3,
      startTimeUnixNano: nanos(s.started_at),
      endTimeUnixNano: nanos(s.finished_at),
      attributes: [
        attr("gen_ai.operation.name", "invoke_agent"),
        attr("gen_ai.agent.name", s.agent),
        ...(s.model ? [attr("gen_ai.request.model", s.model)] : []),
        attr("gen_ai.usage.input_tokens", s.tokens_in),
        attr("gen_ai.usage.output_tokens", s.tokens_out),
        attr("gen_ai.usage.cache_read.input_tokens", s.tokens_cached),
        ...(s.cost_usd === null ? [] : [attr("factory.cost_usd", s.cost_usd)]),
        attr("factory.stage", s.stage),
      ],
      status: { code: s.exit_code === 0 ? 1 : 2 },
    })),
  ];
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", "kaas-factory")] },
        scopeSpans: [{ scope: { name: "kaas-factory" }, spans }],
      },
    ],
  };
}

// `k=v,k2=v2`, the OTLP exporter's own header format.
export function otlpHeaders(raw = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=");
    if (at > 0) out[pair.slice(0, at).trim()] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  return out;
}

export async function exportTrace(endpoint: string, headers: string | undefined, body: unknown): Promise<void> {
  const res = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json", ...otlpHeaders(headers) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`otlp export answered ${res.status}`);
}
