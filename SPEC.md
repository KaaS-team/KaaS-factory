<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Blocked by: mc-2 (not filed yet)
Deps: none
Epic: E14 Mission control
Milestone: Phase 7 mission control
Runner: factory

## Risk: high

## Why
A company that runs agents in its own cloud or sandbox needs no adapter written for it: it already emits OpenTelemetry, or it can POST a signed webhook. Mission control accepts both, maps them onto the session shape, and stores only state, stage, cost and a link. These are the only inbound endpoints mission control adds, so they carry the strictest checks: a per-connection secret, a signature over raw bytes, a size cap, and no field copied that the schema does not name.

## Today
- `dashboard/server.ts` `POST /events` takes inbound CloudEvents with the bus HMAC; `src/core/event.ts` names the types.
- `src/integrations/otel.ts:108` exports an OTLP/JSON trace per run (outbound only); nothing receives OTLP.
- OpenTelemetry GenAI agent spans: `invoke_agent` and `execute_tool` operations, `gen_ai.conversation.id`, `gen_ai.agent.name`, `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`; status Development. https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-agent-spans.md
- GitHub validates webhook deliveries with `X-Hub-Signature-256: sha256=` HMAC over the raw body and a constant-time compare. https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries

## Change
### T1: OTLP receiver mapping
Files: `src/mc/adapters/otlp.ts`, `tests/mc-adapter-otlp.test.ts`, `tests/fixtures/mc/otlp/trace.json`
Model: opus
1. `fromOtlpTraces(body, conn)` reads OTLP/HTTP JSON `resourceSpans`, keeps spans whose `gen_ai.operation.name` is `invoke_agent`, and maps each to an `AgentSession` with `externalId` from `gen_ai.conversation.id` (else the trace id), `title` from `gen_ai.agent.name`, `state` from the span status (`OK` to `succeeded`, `ERROR` to `failed`, an open span to `running`), `tokensIn` and `tokensOut` from usage, and `costUsd` from `factory.cost_usd` when present, else `null`.
2. `repo`, `issue` and `link` come only from the resource attributes `factory.repo`, `factory.issue` and `factory.link` (https only), so an agent ties itself to a run by naming it.
3. Every other attribute, span event and log body is dropped; strings pass `redactText`.
4. `otlpAdapter(store)` with `kind: "otlp"`, caps `{list: true, events: "push", cancel: false, followUp: false, deepLink: true}` reads what the receiver stored.
5. Tests: the fixture (written by hand from the convention) maps; an `execute_tool` span alone yields no session; a prompt attribute never reaches a row; the kit passes.

### T2: Generic signed webhook
Files: `src/mc/adapters/webhook.ts`, `tests/mc-adapter-webhook.test.ts`
Model: sonnet
1. A documented body `{id, title, state, repo?, issue?, stage?, link?, costUsd?, at}` checked by `SESSION_SCHEMA` rules, signed with `X-Factory-Signature: sha256=<hex>` over the raw body using the connection's `webhookSecretEnv`, the header the outbox sinks already send.
2. `verify(raw, header, secret)` uses `timingSafeEqual`, rejects a body over 64 KiB before hashing, and rejects an `at` more than 5 minutes from now so a captured body cannot replay later.
3. `webhookAdapter(store)` with `kind: "webhook"`, caps `{list: true, events: "push", cancel: false, followUp: false, deepLink: true}`.
4. Tests: a good body stores; a wrong signature, an old `at`, a 65 KiB body and an unknown key are each rejected; the kit passes.

### T3: The intake routes
Files: `src/mc/intake.ts`, `tests/mc-intake.test.ts`, `tests/mutations/mc-webhook-replay-window-gone.json`, `tests/mutations/mc-intake-reveals-connection-names.json`
Model: sonnet
Deps: T1, T2
1. `intakeRoutes(deps)` returns `ApiRoute` rows for `POST /api/mc/intake/otlp/:connection/v1/traces`, `POST /api/mc/intake/webhook/:connection` and `POST /api/mc/intake/claude-code/:connection` (mc-4 `fromHook`), each with `auth: "connection"`: the request names a configured connection, and the bearer or signature must match that connection's secret, so one leaked secret opens one connection.
2. An unknown connection and a bad credential both answer `404` with the same body, so a caller cannot probe names; a body over the cap answers `413` before it is read.
3. Tests: each route stores on a good request; a wrong secret and an unknown name are indistinguishable; the 413 fires before parse.
4. Save each entry under Mutation as its own file (`tests/mutations/mc-webhook-replay-window-gone.json`, `tests/mutations/mc-intake-reveals-connection-names.json`), a single JSON object each. Never edit the old mutations list.

## Tests
- `tests/mc-adapter-otlp.test.ts`: [permanent] agent spans map, other attributes drop, kit passes.
- `tests/mc-adapter-webhook.test.ts`: [permanent] signature, replay, size and schema checks.
- `tests/mc-intake.test.ts`: [permanent] per-connection credentials, uniform 404, size cap before parse.

## Mutation
```json
{"name":"mc: webhook replay window gone","file":"src/mc/adapters/webhook.ts","find":"Math.abs(now - at) > REPLAY_MS","replace":"false","test":"tests/mc-adapter-webhook.test.ts"}
```
```json
{"name":"mc: intake reveals connection names","file":"src/mc/intake.ts","find":"if (!conn || !ok) return notFound()","replace":"if (!conn) return notFound(); if (!ok) return unauthorized()","test":"tests/mc-intake.test.ts"}
```

## Acceptance
- AC-1: an agent in any cloud that emits GenAI spans shows as a session with no prompt text kept: checked by `make test FILES=tests/mc-adapter-otlp.test.ts` (T1)
- AC-2: a signed webhook is verified, size-capped and replay-checked before it is stored: checked by `make test FILES=tests/mc-adapter-webhook.test.ts` (T2)
- AC-3: each intake route takes only its own connection's secret and reveals nothing about others: checked by `make test FILES=tests/mc-intake.test.ts` (T3)

## Non-goals
- NG-1: no OTLP protobuf and no gRPC; OTLP/HTTP JSON only.
- NG-2: no metrics or logs storage; spans and the named log are mapped, then dropped.
- NG-3: the routes are declared here and mounted by mc-8.

## Files
- `src/mc/adapters/otlp.ts` (new)
- `src/mc/adapters/webhook.ts` (new)
- `src/mc/intake.ts` (new)
- `tests/mc-adapter-otlp.test.ts` (new)
- `tests/mc-adapter-webhook.test.ts` (new)
- `tests/mc-intake.test.ts` (new)
- `tests/fixtures/mc/otlp/trace.json` (new)
- `tests/mutations/mc-webhook-replay-window-gone.json` (new)
- `tests/mutations/mc-intake-reveals-connection-names.json` (new)
