// One OpenTelemetry trace per run: a root span for the run and a gen_ai invoke_agent span per stage,
// exported as OTLP/JSON to OTEL_EXPORTER_OTLP_ENDPOINT with OTEL_EXPORTER_OTLP_HEADERS when the run ends.
import { afterAll, describe, expect, test } from "bun:test";
import type { CloudEvent } from "../src/core/event";
import { LinkStore } from "../src/integrations/links";
import { auditTrace, OTEL_ENV, otlpHeaders, runTrace } from "../src/integrations/otel";
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
    expect(spans.map((s) => s.name)).toEqual([
      "factory.run issue/5",
      "invoke_agent claude",
      "chat m-1",
      "invoke_agent claude",
      "chat m-1",
    ]);
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
    expect(
      spans.filter((s) => s.name.startsWith("invoke_agent")).every((s) => s.parentSpanId === spans[0]!.spanId),
    ).toBe(true);
    expect(spans[2]!.parentSpanId).toBe(spans[1]!.spanId);
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
    expect(spansOf(a).map((x) => x.name)).toEqual(["factory.run issue/5", "invoke_agent claude"]);
    expect(spansOf(a)[1]!.attributes.map((x) => x.key)).not.toContain("gen_ai.request.model");
    expect(runTrace({ repo: "acme/shop", issue: 5, outcome: "failed" }, [])).toBeUndefined();
    expect(otlpHeaders("a=1, b=x%3Dy")).toEqual({ a: "1", b: "x=y" });
  });
});

describe("audit events as OTel spans", () => {
  const auditEv = (id: string, actor: string, issue: number | null) =>
    ({
      specversion: "1.0",
      id,
      type: "factory.audit.recorded",
      source: "f",
      subject: "POST /api/toggles",
      time: "2026-10-26T10:00:00.000Z",
      data: { at: "2026-10-26T10:00:00.000Z", actor, role: "owner", route: "POST /api/toggles", issue, status: 200 },
    }) as CloudEvent;
  const wire = (env: Record<string, string>) => {
    const subs: ((e: CloudEvent) => Promise<void>)[] = [];
    wireIntegrations({
      subscribe: (_t, fn) => subs.push(fn),
      links: new LinkStore(":memory:"),
      stageRuns: () => [],
      env,
    });
    return subs;
  };

  test("the fixture exporter receives one span per event, with event type, actor and issue", async () => {
    got.length = 0;
    const subs = wire({ [OTEL_ENV.endpoint]: collector.url.origin });
    for (const e of [auditEv("a1", "ada", 7), auditEv("a2", "bob", null)]) for (const fn of subs) await fn(e);
    expect(got.map((g) => g.path)).toEqual(["/v1/traces", "/v1/traces"]);
    const spans = got.map((g) => spansOf(g.body));
    expect(spans.every((s) => s.length === 1)).toBe(true);
    const attrs = (i: number) =>
      Object.fromEntries(
        (spans[i]![0]!.attributes as { key: string; value: Record<string, string> }[]).map((a) => [
          a.key,
          Object.values(a.value)[0],
        ]),
      );
    expect(spans[0]![0]!.name).toBe("factory.audit.recorded");
    expect(attrs(0)).toMatchObject({
      "factory.event.type": "factory.audit.recorded",
      "factory.actor": "ada",
      "factory.issue": "7",
    });
    expect(Object.keys(attrs(1))).not.toContain("factory.issue");
    expect(spans[0]![0]!.spanId).not.toBe(spans[1]![0]!.spanId);
  });

  test("with no exporter configured, nothing is sent", async () => {
    got.length = 0;
    const subs = wire({});
    for (const fn of subs) await fn(auditEv("a3", "ada", 7));
    expect(got).toEqual([]);
  });

  test("the same event gives the same ids", () => {
    expect(auditTrace(auditEv("a1", "ada", 7))).toEqual(auditTrace(auditEv("a1", "ada", 7)));
  });
});
