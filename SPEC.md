<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Blocked by: mc-2 (not filed yet)
Deps: none
Epic: E14 Mission control
Milestone: Phase 7 mission control
Runner: factory

## Risk: medium

## Why
Cursor cloud agents have the most complete public API of the targets: list, get, a resumable event stream per run, cancel and follow-up. The adapter maps it onto the session port one to one and links each row to the agent's own page, so a user watches the run in Cursor and sees its state, cost and needs in mission control.

## Today
- `docs/agent-research/cursor` records the local Cursor CLI; no module calls the cloud agents API.
- Verified API (primary source https://cursor.com/docs/cloud-agent/api/endpoints):
  - `GET /v1/agents`, `GET /v1/agents/{id}`; an agent has `status` `ACTIVE`, `IDLE` or `ARCHIVED` and a `url` field (`https://cursor.com/agents/{id}`).
  - `POST /v1/agents/{id}/runs` starts a follow-up run; `409 agent_busy` when one is running; `"delivery": "steer"` sends it into the active run.
  - `GET /v1/agents/{id}/runs/{runId}/stream` is SSE and accepts `Last-Event-ID`; `400 invalid_last_event_id` and `410 stream_expired` mean resume from a fresh read.
  - `POST /v1/agents/{id}/runs/{runId}/cancel`; `409 run_not_cancellable`.
  - A run has `status` `CREATING`, `RUNNING`, `WAITING_FOR_BACKGROUND_WORK`, `FINISHED`, `ERROR`, `CANCELLED` or `EXPIRED`.
  - Auth is Basic with the key as the user name, or Bearer.
- Webhooks send `statusChange` with an `X-Webhook-Signature: sha256=` HMAC. https://cursor.com/docs/cloud-agent/api/webhooks
- `src/adapters/sse/event-source.ts` is a fetch-based SSE reader with a Bearer header and `Last-Event-ID`.

## Change
### T1: The Cursor adapter
Files: `src/mc/adapters/cursor.ts`, `tests/mc-adapter-cursor.test.ts`, `tests/fixtures/mc/cursor/agents.json`, `tests/fixtures/mc/cursor/stream.txt`
Model: opus
1. `cursorAdapter(conn: { name; url? }, deps: { fetch: typeof safeFetch; key: () => string })` with `kind: "cursor"`, caps `{list: true, events: "push", cancel: true, followUp: true, deepLink: true}`. Every call goes through `safeFetch` with `hosts: ["api.cursor.com"]` (or the connection's `url` host) and the key in the `Authorization` header only.
2. `RUN_STATE: Record<CursorRunStatus, SessionState>` maps `CREATING` to `queued`, `RUNNING` and `WAITING_FOR_BACKGROUND_WORK` to `running`, `FINISHED` to `succeeded`, `ERROR` and `EXPIRED` to `failed`, `CANCELLED` to `cancelled`; an unknown value is `unknown`, never a throw.
3. `list` pages `GET /v1/agents`, skips `ARCHIVED`, and keeps `id`, `name` (as `title`, cut to 200), repository, branch, PR URL and `url` (as `link`, only when its origin is `https://cursor.com`). Prompt text and summaries are dropped.
4. `follow(ref, after)` reads the run stream through the SSE reader with `Last-Event-ID: after`; status events become `state` events; on `400 invalid_last_event_id` or `410 stream_expired` it emits one `note` "stream restarted", re-reads the run and resumes with no id. Message and tool events are dropped.
5. `cancel` posts to the run's cancel path and maps `409 run_not_cancellable` to a `SessionUnsupported` with that sentence; `followUp(ref, text)` posts a run with `"delivery": "steer"` when the agent is busy, else a plain run.
6. Fixtures are written by hand from the documented shapes and hold no real id or key.
7. Tests with a scripted fake fetch: the kit passes; every status maps; an archived agent is skipped; a `410` resumes once; a link to another origin is dropped; the key never appears in a URL the fake fetch saw.

### T2: Webhook verification
Files: `src/mc/adapters/cursor-webhook.ts`, `tests/mc-cursor-webhook.test.ts`, `tests/mutations/mc-cursor-stream-never-resumes.json`, `tests/mutations/mc-cursor-webhook-unsigned.json`
Model: sonnet
Deps: T1
1. `verifyCursorWebhook(rawBody, header, secret)` checks `sha256=<hex>` with `timingSafeEqual` over the raw bytes; `fromCursorWebhook(body)` maps `statusChange` to a `state` event.
2. Tests: a good signature passes; a flipped byte, a missing prefix and a different length fail; a body is never parsed before it verifies.
3. Save each entry under Mutation as its own file (`tests/mutations/mc-cursor-stream-never-resumes.json`, `tests/mutations/mc-cursor-webhook-unsigned.json`), a single JSON object each. Never edit the old mutations list.

## Tests
- `tests/mc-adapter-cursor.test.ts`: [permanent] kit, status map, stream resume, link origin, key never in a URL.
- `tests/mc-cursor-webhook.test.ts`: [permanent] signature check before parse.

## Mutation
```json
{"name":"mc: cursor stream never resumes","file":"src/mc/adapters/cursor.ts","find":"if (res.status === 410 || res.status === 400)","replace":"if (false)","test":"tests/mc-adapter-cursor.test.ts"}
```
```json
{"name":"mc: cursor webhook unsigned","file":"src/mc/adapters/cursor-webhook.ts","find":"timingSafeEqual(a, b)","replace":"true","test":"tests/mc-cursor-webhook.test.ts"}
```

## Acceptance
- AC-1: Cursor agents list, follow, cancel and accept follow-ups through the guarded fetch, linking to their own page: checked by `make test FILES=tests/mc-adapter-cursor.test.ts` (T1)
- AC-2: a webhook is verified over raw bytes before it is read: checked by `make test FILES=tests/mc-cursor-webhook.test.ts` (T2)

## Non-goals
- NG-1: no launching of Cursor agents from mission control; a stage or the user starts them.
- NG-2: no conversation or artifact download; the link is the view.
- NG-3: no webhook route; mc-7 owns inbound endpoints.

## Files
- `src/mc/adapters/cursor.ts` (new)
- `src/mc/adapters/cursor-webhook.ts` (new)
- `tests/mc-adapter-cursor.test.ts` (new)
- `tests/mc-cursor-webhook.test.ts` (new)
- `tests/fixtures/mc/cursor/agents.json` (new)
- `tests/fixtures/mc/cursor/stream.txt` (new)
- `tests/mutations/mc-cursor-stream-never-resumes.json` (new)
- `tests/mutations/mc-cursor-webhook-unsigned.json` (new)
