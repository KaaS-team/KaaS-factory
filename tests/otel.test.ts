// One OpenTelemetry trace per run: a root span for the run and a gen_ai invoke_agent span per stage,
// exported as OTLP/JSON to OTEL_EXPORTER_OTLP_ENDPOINT with OTEL_EXPORTER_OTLP_HEADERS when the run ends.
import { afterAll, describe, expect, test } from "bun:test";
import type { CloudEvent } from "../src/core/event";
import { LinkStore } from "../src/integrations/links";
import { OTEL_ENV, otlpHeaders, runTrace } from "../src/integrations/otel";
import { wireIntegrations } from "../src/integrations/wire";
import type { StageRun } from "../src/state";

const got: { path: string; auth: string | null; body: unknown }[] = [];
const collector = Bun.serve({
  port: 0,
  async fetch(req) {
    got.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() });
    return Response.json({});
  },
});
afterAll(() => collector.stop());

const stage = (id: number, name: string, at: string, model: string | null = "m-1"): StageRun =>
  ({
    id,
    repo: "acme/shop",
    issue: 5,
    stage: name,
    agent: "claude",
    model,
    started_at: at,
    finished_at: at.replace(":00.", ":30."),
    tokens_in: 100 * id,
    tokens_out: 10 * id,
    tokens_cached: id,
    cost_usd: 0.5,
    exit_code: 0,
  }) as StageRun;

type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string; attributes: { key: string }[] };
const spansOf = (body: unknown) =>
  (body as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }).resourceSpans[0]!.scopeSpans[0]!.spans;

describe("OTel gen_ai trace", () => {
  test("a run ends with one trace: a root span and a gen_ai span per stage, sent to the collector", async () => {
    got.length = 0;
    const old = stage(1, "triage", "2026-10-26T09:00:00.000Z");
    const stages = [old, stage(2, "triage", "2026-10-26T10:00:00.000Z"), stage(3, "build", "2026-10-26T10:01:00.000Z")];
    const subs: ((e: CloudEvent) => Promise<void>)[] = [];
    wireIntegrations({
      subscribe: (_t, fn) => subs.push(fn),
      links: new LinkStore(":memory:"),
      stageRuns: () => stages,
      env: { [OTEL_ENV.endpoint]: `${collector.url.origin}/`, [OTEL_ENV.headers]: "authorization=Bearer%20k" },
    });
    const ev = (type: string, time: string, data: Record<string, unknown>) =>
      ({ specversion: "1.0", id: type, type, source: "f", subject: "issue/5", time, data }) as CloudEvent;
    const base = { repo: "acme/shop", issue: 5, workflow: "default" };
    for (const e of [
      ev("factory.step.started", "2026-10-26T09:59:59.000Z", { ...base, step: "triage" }),
      ev("factory.run.completed", "2026-10-26T10:02:00.000Z", { ...base, outcome: "pr-opened" }),
    ])
      for (const fn of subs) await fn(e);

    expect(got.map((g) => [g.path, g.auth])).toEqual([["/v1/traces", "Bearer k"]]);
    const spans = spansOf(got[0]!.body);
    expect(spans.map((s) => s.name)).toEqual(["factory.run issue/5", "invoke_agent triage", "invoke_agent build"]);
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
    expect(spans.slice(1).every((s) => s.parentSpanId === spans[0]!.spanId)).toBe(true);
    expect(spans[1]!.attributes.map((a) => a.key)).toEqual([
      "gen_ai.operation.name",
      "gen_ai.agent.name",
      "gen_ai.request.model",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "gen_ai.usage.cache_read.input_tokens",
      "factory.cost_usd",
      "factory.stage",
    ]);
  });

  test("the same run gives the same ids, and a run with no stages exports nothing", () => {
    const stages = [stage(7, "build", "2026-10-26T10:01:00.000Z", null)];
    const a = runTrace({ repo: "acme/shop", issue: 5, outcome: "failed" }, stages);
    expect(a).toEqual(runTrace({ repo: "acme/shop", issue: 5, outcome: "failed" }, stages));
    expect(spansOf(a)[1]!.attributes.map((x) => x.key)).not.toContain("gen_ai.request.model");
    expect(runTrace({ repo: "acme/shop", issue: 5, outcome: "failed" }, [])).toBeUndefined();
    expect(otlpHeaders("a=1, b=x%3Dy")).toEqual({ a: "1", b: "x=y" });
  });
});
