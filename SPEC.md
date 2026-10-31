<!-- factory:planned v1 -->
Blocked by: #192
## Why
Every client (dashboard, CLI, a future desktop or web shell) talks to the factory through ad hoc routes in `dashboard/server.ts`. There is no single route table, no schema for a response, no live event contract and no typed client. This epic adds one declared API surface in `src/api/`: a `ROUTES` table with JSON schemas, a generated `openapi.json` that a test pins, a live SSE stream with replay, a token gate, `factory serve` with a seeded fixture, and a client generated from the same table. One table drives the server, the docs, the client and the contract test, so they cannot drift.

## Today
- `dashboard/server.ts:736` lines, frozen in `quality-baseline.json`; routes are `{method, pattern, label, role, repo, handler}` rows inside `createDashboard`, with no response schema.
- `dashboard/workflow-routes.ts:138` serves `GET /api/events` as the event-bus listing (operator role); `:150` serves `POST /api/events/:event/replay`.
- `dashboard/public/lib/workflow-pages.js:18` loads the bus listing from `/api/events`; `:96` posts the replay.
- `tests/workflow-pages.test.ts:80`, `:88`, `:92` and `tests/multi-repo.test.ts:386` call `/api/events`; `docs/control-plane.md:76` documents it.
- `dashboard/server.ts` `GET /api/stream` sends a full runs snapshot every 2s with no event ids, so a reconnecting client cannot resume.
- `src/schemas.ts:168` holds a private `fits(prop, v)` validator (type, enum, anyOf, items); `package.json` has no runtime dependencies, so no zod.
- `src/state.ts` exposes `listRuns(repo?)`, `getRun(repo, issue)`, `listEvents(runId, {after, limit})`, `listStageRuns` and `spendSummary`; one state db per repo.
- `src/cli.ts` is frozen at 1084 lines; `cmdEvents` sits at `src/cli.ts:944` and its dispatch case at `src/cli.ts:1056`.
- `src/help.ts:131` documents `events`; `tests/help.test.ts` diffs `COMMANDS` against the `cli.ts` switch.
- Nothing exists yet under `src/api/`, `packages/` or `scripts/openapi.ts`; issue #192 (packages/protocol) is still open.

## Change
### T1: Declare ROUTES and LIVE_EVENTS (P2a)
Files: `src/api/routes.ts`, `src/api/events.ts`, `src/schemas.ts`, `tests/api-routes.test.ts`
Model: sonnet
1. In `src/schemas.ts` export the existing `fits` as `fitsSchema(schema, value): boolean` (rename the export only; keep the private name as an alias so callers do not change).
2. Create `src/api/routes.ts` exporting `interface ApiRoute {id, method: "GET"|"POST", path, auth: "none"|"token", req?: JsonSchema, res: JsonSchema}` and `ROUTES: readonly ApiRoute[]` with: `health` (GET `/api/health`, auth none), `repos.list` (GET `/api/repos`), `runs.list` (GET `/api/runs?repo=`), `runs.get` (GET `/api/runs/:repo/:issue`), `runs.events` (GET `/api/runs/:repo/:issue/events?after=`), `spend.get` (GET `/api/spend`), `stream` (GET `/api/events`, SSE).
3. Schemas are hand-written JSON Schema objects that mirror `Run`, `RunEvent` and the spend summary from `src/state.ts`; `Stage` and `RunStatus` enums are copied from the state types and pinned by a test that compares them.
4. Create `src/api/events.ts` exporting `LIVE_EVENTS` = `run.updated`, `stage.started`, `stage.finished`, `log.appended`, `inbox.changed`, `message.queued`, `repo.changed`, each with a payload schema, and `type LiveEvent = {id: number, type: keyof LIVE_EVENTS, data}`.
5. Test: every route id is unique, every path starts with `/api/`, every non-health route is `auth: "token"`, and the state enums equal the schema enums.

### T2: Generate openapi.json and pin it (P2b)
Files: `scripts/openapi.ts`, `src/api/openapi.json`, `tests/api-routes.test.ts`
Model: haiku
1. `scripts/openapi.ts` exports `buildOpenApi(ROUTES, LIVE_EVENTS)` (OpenAPI 3.1: one path item per route, `:param` becomes `{param}`, `bearerAuth` security on token routes, `x-live-events` holding the event schemas) and, when run, writes `src/api/openapi.json` with 2-space JSON and a trailing newline.
2. Run it once and commit the output.
3. Test: `buildOpenApi` output deep-equals the committed file; the failure message says `run bun scripts/openapi.ts`.

### T3: Move the bus listing to /api/bus-events
Files: `dashboard/workflow-routes.ts`, `dashboard/public/lib/workflow-pages.js`, `tests/workflow-pages.test.ts`, `tests/multi-repo.test.ts`, `docs/control-plane.md`
Model: haiku
1. In `dashboard/workflow-routes.ts` change the listing route's pattern and label to `GET /api/bus-events`; the replay route moves to `POST /api/bus-events/:event/replay`.
2. Update `EXTRA_LOADERS.events` and the replay `post` in `workflow-pages.js`.
3. Update the four test call sites and `docs/control-plane.md:76`.
4. `/api/events` is now free for the live stream in T4.

### T4: Core routes, token auth and the live stream (P3a)
Files: `src/api/core.ts`, `src/api/auth.ts`, `src/api/stream.ts`, `tests/api-contract.test.ts`
Model: opus
1. `src/api/auth.ts` exports `tokenAuth(env)` returning `(req) => boolean`: reads `FACTORY_API_TOKEN`, compares the `Authorization: Bearer` value with `crypto.timingSafeEqual` over equal-length buffers (length mismatch is false), and refuses every token route when the env var is unset.
2. `src/api/stream.ts` exports `class LiveFeed` with a ring buffer of 1000 events and a monotonically increasing id: `push(type, data)`, `since(lastId)` returning `{events}` when `lastId` is still in the buffer or `{reset: true}` when it fell out. `sseResponse(feed, lastEventId, signal)` writes `id:` and `event:` lines, sends `event: reset` when needed, and a `: heartbeat` comment every 15s (interval injectable for tests).
3. `src/api/core.ts` exports `coreRoutes(deps: {repos(): string[], state(repo): FactoryState-like, feed: LiveFeed, auth})` returning `{fetch(req): Promise<Response>}`; it matches every `ROUTES` entry and 404s anything else, 401s a token route without a valid token, 400s a malformed `:issue`.
4. `startFeedPoller(deps, feed, everyMs)` diffs `listRuns` (by `updated_at`, stage and status) and `listEvents(after)` into `run.updated`, `stage.started`, `stage.finished` and `log.appended` pushes.
5. Contract test walks `ROUTES`: for each GET route it calls `coreRoutes` over the fixture of T5 and checks the body with `fitsSchema` against `res`; every pushed event validates against its `LIVE_EVENTS` schema; a reconnect with a stale `Last-Event-ID` gets `reset`; a wrong token gets 401.

### T5: factory serve, fixture and generated client (P3b, D0)
Files: `src/api/client.ts`, `src/api/fixtures.ts`, `src/api/serve-cli.ts`, `src/events-cli.ts`, `src/cli.ts`, `src/help.ts`, `quality-baseline.json`, `tests/api-client.test.ts`
Model: sonnet
1. `src/api/fixtures.ts` exports `fixture("two-repos")`: an in-memory state stub with 2 repos and 3 runs (one running, one awaiting-review, one done) plus events.
2. `src/api/client.ts` exports `createClient(baseUrl, token, fetchImpl = fetch)` whose methods are derived from `ROUTES` ids (`client.runs.list({repo})`), and `fakeClient(name)` = `createClient` over an in-process `coreRoutes(fixture(name)).fetch`.
3. `src/api/serve-cli.ts` exports `cmdServe(cli)`: `factory serve [--port N] [--fixture two-repos] [--print-url]`, built on `Bun.serve` with `coreRoutes`; without `--fixture` it reads the repos the inbox serves and their state dbs; `--print-url` prints `http://127.0.0.1:<port>` once listening.
4. Move `cmdEvents` from `src/cli.ts:944` into new `src/events-cli.ts` as `cmdEvents(ctx)` using the harness `CliContext` (`statePath`, `args`, `flag`, `has`); `src/cli.ts` dispatches `case "events": return (await import("./events-cli")).cmdEvents(harnessCtx());` and `case "serve": return (await import("./api/serve-cli")).cmdServe(cli);`.
5. Add a `serve` entry to `COMMANDS` in `src/help.ts`.
6. Set `lines["src/cli.ts"]` in `quality-baseline.json` to the new `wc -l` (it must shrink, not grow).
7. Test: `fakeClient("two-repos").runs.list()` returns 3 runs that pass the schema; `cmdServe` with `--fixture two-repos --port 0` answers `/api/health`.

### T6: Goals and mutations
Files: `goals.json`, `tests/mutations/api-token-compare-always-passes.json`, `tests/mutations/api-stale-id-never-resets.json`, `tests/mutations/api-schema-arrays-unchecked.json`, `tests/mutations/api-openapi-drops-token-security.json`
Model: haiku
1. Add phase `{"id":"v7-modular","title":"Agnostic modular core","release":"7.0.0"}` to `goals.json` if absent.
2. Add one goal per task T1, T2, T4, T5 with `phase: "v7-modular"`, a proof `{test, name, mutation}` naming the tests above.
3. Save each entry from the Mutation section as its own file (`tests/mutations/api-token-compare-always-passes.json`, `tests/mutations/api-stale-id-never-resets.json`, `tests/mutations/api-schema-arrays-unchecked.json`, `tests/mutations/api-openapi-drops-token-security.json`), a single JSON object each. Never edit the old mutations list.

## Tests
- `tests/api-routes.test.ts`: route ids are unique and token-gated [unit]
- `tests/api-routes.test.ts`: state Stage and RunStatus enums equal the schema enums [unit]
- `tests/api-routes.test.ts`: openapi.json matches buildOpenApi output [structural]
- `tests/api-contract.test.ts`: every GET route answers a body that fits its res schema [contract]
- `tests/api-contract.test.ts`: every pushed live event fits its LIVE_EVENTS schema [contract]
- `tests/api-contract.test.ts`: a stale Last-Event-ID gets a reset event [unit]
- `tests/api-contract.test.ts`: a wrong bearer token gets 401 [security]
- `tests/api-client.test.ts`: fakeClient two-repos lists 3 runs [integration]
- `tests/api-client.test.ts`: factory serve with a fixture answers health [integration]
- `tests/workflow-pages.test.ts`: the bus listing loads from /api/bus-events [unit]
- `tests/help.test.ts`: serve is documented and dispatched [structural]

## Mutation
```json
{"name":"api: token compare always passes","file":"src/api/auth.ts","find":"timingSafeEqual(","replace":"true || timingSafeEqual(","test":"tests/api-contract.test.ts"}
```

```json
{"name":"api: stale id never resets","file":"src/api/stream.ts","find":"reset: true","replace":"reset: false","test":"tests/api-contract.test.ts"}
```

```json
{"name":"api: schema arrays unchecked","file":"src/schemas.ts","find":"return Array.isArray(v) && v.every(","replace":"return Array.isArray(v) || v.every(","test":"tests/api-contract.test.ts"}
```

```json
{"name":"api: openapi drops token security","file":"scripts/openapi.ts","find":"bearerAuth","replace":"noAuth","test":"tests/api-routes.test.ts"}
```

## Acceptance
- AC-1: ROUTES and LIVE_EVENTS declare every route and live event with schemas: checked by `make test FILES="tests/api-routes.test.ts"` (T1)
- AC-2: openapi.json is generated and drift fails a test: checked by `make test FILES="tests/api-routes.test.ts"` (T2)
- AC-3: the bus listing moved to /api/bus-events and the dashboard still loads it: checked by `make test FILES="tests/workflow-pages.test.ts tests/multi-repo.test.ts"` (T3)
- AC-4: every route answers schema-valid bodies, events validate, replay resets, bad tokens are refused: checked by `make test FILES="tests/api-contract.test.ts"` (T4)
- AC-5: factory serve runs a seeded fixture and the generated client reads it: checked by `make test FILES="tests/api-client.test.ts tests/help.test.ts"` (T5)
- AC-6: goals and mutations are registered and the quality ratchet holds: checked by `make check` (T6)

## Non-goals
- NG-1: W4a ServerFactory (`type ServerFactory = (deps) => {fetch}` registered as a `servers` contribution) moves to a follow-up; it needs the plugin registry from #193.
- NG-2: moving `src/api/` into `packages/protocol` is the follow-up in #196 (SD1); this epic does not depend on #192.
- NG-3: no write routes (approve, retry, label) in ROUTES yet; read and stream only.
- NG-4: `dashboard/server.ts` keeps its own routes and `/api/stream`; it does not mount `coreRoutes` in this epic.
- NG-5: `inbox.changed`, `message.queued` and `repo.changed` are declared with schemas but nothing pushes them yet.

## Files
- `src/api/routes.ts` (new)
- `src/api/events.ts` (new)
- `src/api/openapi.json` (new)
- `src/api/core.ts` (new)
- `src/api/auth.ts` (new)
- `src/api/stream.ts` (new)
- `src/api/client.ts` (new)
- `src/api/fixtures.ts` (new)
- `src/api/serve-cli.ts` (new)
- `src/events-cli.ts` (new)
- `scripts/openapi.ts` (new)
- `src/schemas.ts`
- `src/cli.ts`
- `src/help.ts`
- `quality-baseline.json`
- `dashboard/workflow-routes.ts`
- `dashboard/public/lib/workflow-pages.js`
- `docs/control-plane.md`
- `goals.json`
- `tests/mutations/api-token-compare-always-passes.json` (new)
- `tests/mutations/api-stale-id-never-resets.json` (new)
- `tests/mutations/api-schema-arrays-unchecked.json` (new)
- `tests/mutations/api-openapi-drops-token-security.json` (new)
- `tests/api-routes.test.ts` (new)
- `tests/api-contract.test.ts` (new)
- `tests/api-client.test.ts` (new)
- `tests/workflow-pages.test.ts`
- `tests/multi-repo.test.ts`

## Risk: medium
The token gate is security relevant and `/api/events` changes meaning, so any outside script that polled the bus listing breaks (the rename is grep-complete inside the repo). `quality-baseline.json`, `goals.json`, `src/help.ts` are also touched by #197 and #198; a rebase conflict there resolves to both entries and the exact `wc -l` of `src/cli.ts`.
## Model: opus


