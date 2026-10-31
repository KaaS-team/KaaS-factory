<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Blocked by: #195 (`ROUTES`, `LiveFeed`, `factory serve`), mc-3 (merged in #422)
Deps: #195
Epic: E14 Mission control
Milestone: Phase 7 mission control
Runner: factory

## Risk: high

## Why
Adapters answer one call at a time; mission control needs one live list that a browser, a phone and a terminal all read the same way. The hub polls or follows every configured connection, keeps the last known rows in a small store, publishes changes on the #195 live feed, and serves them through typed routes over SSE and WebSocket. When a connection cannot be reached, its rows stay with a `stale_since` time, so the page says offline instead of going blank. A team policy names who may cancel or follow up and whether share links exist.

## Today
- After #195: `src/api/routes.ts` `ROUTES` with schemas and least roles, `LiveFeed` (ring of 1000 events, SSE ids, `Last-Event-ID` resume, a `reset` event, a 15 s heartbeat), `tokenAuth`, `createClient` and `factory serve`.
- `dashboard/server.ts` `GET /api/stream` sends a run snapshot every 2 s with no ids; `dashboard/plane/access.ts` resolves the actor (cookie session, break-glass bearer, loopback) and `tests/plane-access.test.ts` walks every route's least role.
- `src/team/schema.ts` `PolicySpec` has `risk_max`, `auto_merge`, `models`, `protected_paths`, `approvals`, `budget_usd_month` and `extend`; `src/team/resolve.ts` resolves policy strictest-wins; `src/team/hash.ts` `configHash` hashes the resolved config.
- WebSocket in a browser cannot send an `Authorization` header; the common pattern is a short-lived ticket or a cookie. https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource and https://pkg.go.dev/k8s.io/apiserver/pkg/authentication/request/websocket

## Change
### T1: Store and hub
Files: `src/mc/store.ts`, `src/mc/hub.ts`, `src/mc/log.ts`, `tests/mc-hub.test.ts`
Model: opus
1. `McStore` over `FACTORY_HOME/mc.db`: `sessions(runtime, connection, external_id, row_json, updated_at, stale_since)` keyed on the ref, `cursors(connection, external_id, cursor)` and `events(seq, ref, at, json)` kept for `retain_days` (T4, default 14). Every row is written through `redactRow` and must fit `SESSION_SCHEMA`; a row that does not is dropped and counted.
2. `Hub(adapters, store, feed, clock)` runs one loop per connection: `list` on a backoff from 15 s to 5 min with jitter, `follow` for each live session when `caps.events` is `push`, and a cursor saved after each event. A failed call sets `stale_since` on that connection's rows and never removes them.
3. Each change publishes `session.updated` or `session.event` on the #195 `LiveFeed`, so SSE ids and resume come from one place.
4. A child session (mc-3) and a vendor row with the same `externalId` merge: the vendor fills state and link, the factory row keeps repo, issue, stage and `configHash`.
5. `src/mc/log.ts` is the one logger under `src/mc/`: it writes through `redactText` with every resolved secret.
6. Tests with `fakeAdapter` and a fake clock: rows land; a failing adapter marks rows stale and keeps them; a merge keeps the run fields; a bad row is dropped; a restart resumes from the saved cursor.

### T2: Routes
Files: `src/mc/routes.ts`, `src/api/routes.ts`, `tests/mc-routes.test.ts`
Model: sonnet
Deps: T1
1. `MC_ROUTES: ApiRoute[]` with schemas: `GET /api/mc/sessions` (viewer; filters `repo`, `state`, `runtime`), `GET /api/mc/sessions/:runtime/:connection/:id` (viewer), `POST .../cancel` and `POST .../follow-up` (the policy role from T4, default operator; body `{text}` at most 4000 characters), `GET /api/mc/connections` (operator; names, kinds, caps, `stale_since`, never a value), `POST /api/mc/connections/:name/test` (operator; runs `adapterKit`), `PUT /api/mc/connections/:name` and `DELETE /api/mc/connections/:name` (owner; writes `machine.json` through `connectionProblems`, env names only).
2. `src/api/routes.ts` spreads `MC_ROUTES` into `ROUTES`, so OpenAPI, the client and the access walk see them with no second list.
3. A verb whose cap is `false` answers `409` with the adapter's `SessionUnsupported` sentence.
4. Tests: every route's response fits its schema; a viewer gets `403` on cancel; an unsupported cancel is `409` with the sentence; a `PUT` with a literal key is `400` with the connection sentence.

### T3: SSE and WebSocket
Files: `src/mc/socket.ts`, `src/api/serve.ts`, `tests/mc-socket.test.ts`
Model: opus
Deps: T2
1. `GET /api/mc/stream` is the #195 SSE filtered to `session.*` events, with `Last-Event-ID` resume and `reset` when the ring has moved past it.
2. `POST /api/mc/ws-ticket` (viewer) returns a random ticket valid for 30 s and one use, bound to the actor and stored as a digest; `GET /api/mc/ws?ticket=` upgrades only with a live ticket, or with the session cookie on the same origin. The bearer token is never accepted in a URL.
3. A frame carries the same JSON as the SSE event and passes `withoutOperatorDetail` for a viewer; a socket closes when its actor's session ends.
4. `src/api/serve.ts` mounts the upgrade handler.
5. Tests: a ticket works once and fails at 31 s; `?token=` is refused; a viewer frame has no `costUsd`; a resume after 1000 events gets `reset`.

### T4: Session policy in the team model
Files: `src/team/schema.ts`, `src/team/resolve.ts`, `tests/mc-policy.test.ts`, `tests/mutations/mc-failed-connection-drops-its-rows.json`, `tests/mutations/mc-ws-ticket-reusable.json`, `tests/mutations/mc-share-links-loosen.json`
Model: sonnet
1. `PolicySpec.sessions?: { follow_up_role?: "approver" | "operator" | "owner"; share_links?: boolean; retain_days?: number }`.
2. Strictest wins: the higher role, `false` over `true`, the smaller `retain_days`; a locked org value cannot be loosened by a team or repo.
3. The resolved value enters `configHash`, so a session's hash shows which policy it ran under.
4. Tests: a repo `share_links: true` under an org `false` resolves `false`; the hash changes when the policy does.
5. Save each entry under Mutation as its own file (`tests/mutations/mc-failed-connection-drops-its-rows.json`, `tests/mutations/mc-ws-ticket-reusable.json`, `tests/mutations/mc-share-links-loosen.json`), a single JSON object each. Never edit the old mutations list.

## Tests
- `tests/mc-hub.test.ts`: [permanent] store, backoff, stale rows, merge, cursor resume.
- `tests/mc-routes.test.ts`: [permanent] schemas, roles, unsupported verbs, connection writes.
- `tests/mc-socket.test.ts`: [permanent] tickets, no token in URL, viewer redaction, reset.
- `tests/mc-policy.test.ts`: [permanent] strictest-wins and the hash.

## Mutation
```json
{"name":"mc: failed connection drops its rows","file":"src/mc/hub.ts","find":"store.markStale(conn, now)","replace":"store.clear(conn)","test":"tests/mc-hub.test.ts"}
```
```json
{"name":"mc: ws ticket reusable","file":"src/mc/socket.ts","find":"tickets.delete(digest)","replace":"void digest","test":"tests/mc-socket.test.ts"}
```
```json
{"name":"mc: share links loosen","file":"src/team/resolve.ts","find":"share_links: a.share_links === false || b.share_links === false ? false","replace":"share_links: a.share_links === true || b.share_links === true ? true","test":"tests/mc-policy.test.ts"}
```

## Acceptance
- AC-1: one store holds every connection's sessions and keeps them, marked stale, when a source is down: checked by `make test FILES=tests/mc-hub.test.ts` (T1)
- AC-2: sessions and connections are typed routes in the one `ROUTES` table, with least roles: checked by `make test FILES=tests/mc-routes.test.ts` (T2)
- AC-3: live updates reach SSE and WebSocket with no token in a URL and no operator detail for a viewer: checked by `make test FILES=tests/mc-socket.test.ts` (T3)
- AC-4: the session policy resolves strictest-wins and enters the config hash: checked by `make test FILES=tests/mc-policy.test.ts` (T4)

## Non-goals
- NG-1: no transcript storage; `events` holds the short `SessionEvent` only.
- NG-2: no new auth system; the plane actor and #195 `tokenAuth` decide who calls.
- NG-3: no UI; mc-10 builds the page.

## Files
- `src/mc/store.ts` (new)
- `src/mc/hub.ts` (new)
- `src/mc/log.ts` (new)
- `src/mc/routes.ts` (new)
- `src/mc/socket.ts` (new)
- `tests/mc-hub.test.ts` (new)
- `tests/mc-routes.test.ts` (new)
- `tests/mc-socket.test.ts` (new)
- `tests/mc-policy.test.ts` (new)
- `src/api/routes.ts` (edit: spread `MC_ROUTES`)
- `src/api/serve.ts` (edit: mount the upgrade)
- `src/team/schema.ts` (edit: `PolicySpec.sessions`)
- `src/team/resolve.ts` (edit: strictest-wins for `sessions`)
- `tests/mutations/mc-failed-connection-drops-its-rows.json` (new)
- `tests/mutations/mc-ws-ticket-reusable.json` (new)
- `tests/mutations/mc-share-links-loosen.json` (new)
