<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Blocked by: #195 (T1 only: `fitsSchema` and the `ApiRoute` shape)
Deps: #195
Epic: E14 Mission control
Milestone: Phase 7 mission control
Runner: factory

## Risk: low

## Why
Mission control shows every agent session a run starts, wherever it runs, as one row: run, stage, state, cost, approvals and a link out to the agent's own session view. Every later slice (adapters, hub, CLI, dashboard) speaks one shape, so this slice declares it first: the `SessionAdapter` port with capability flags, the normalized `AgentSession` and `SessionEvent` shapes as JSON Schema, and a contract kit every adapter passes. A verb an adapter cannot do is a `false` flag and throws `SessionUnsupported`, the rule `src/ports/sandbox.ts` already follows.

## Today
- `src/ports/sandbox.ts:7-18` declares `SandboxCapabilities` and `:50` `SandboxUnsupported`; `src/runtime-kit.ts` is the one suite every runtime passes. Nothing like it exists for agent sessions.
- `src/ports/agent.ts:9` `StageEvent` is the per-line event of a local stage; `:107` `StageRunResult.sessionId` and `src/state.ts:101` `stage_runs.session_id` keep the agent's resumable session id. Nothing turns them into a session record.
- `src/state.ts:35-44` `RunStatus` has nine values; `src/state.ts:11` `Stage` has five.
- `src/integrations/links.ts:10` `Link {surface, external, repo, issue}` maps an outside conversation to an issue in `FACTORY_HOME/integrations.db`.
- After #195 T1, `src/schemas.ts` exports `fitsSchema(schema, value)` and `src/api/routes.ts` exports `ApiRoute`.
- `src/ports/` and `src/mc/` hold no session code.

## Change
### T1: The session port
Files: `src/ports/session.ts`
Model: opus
1. `SessionState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown"`. `waiting` means a human is needed (approval, answer, review).
2. `SessionRef { runtime: string; connection: string; externalId: string }`. `runtime` is the adapter kind (`factory`, `claude-code`, `cursor`, `codex`, `acp`, `otlp`, `webhook`); `connection` is the name of a configured connection, never a host or token.
3. `AgentSession { ref; title; state; repo?; issue?; stage?; startedAt; updatedAt; link?; prUrl?; branch?; needsYou?: string; costUsd?: number | null; tokensIn?: number; tokensOut?: number; model?: string; configHash?: string | null }`. `title` and `needsYou` are at most 200 characters. `costUsd: null` means not reported, never zero.
4. `SessionEvent { ref; at; kind: "state" | "stage" | "approval" | "cost" | "link" | "note" | "error"; state?; stage?; text?; costUsd? }`. `text` is a one-line summary, at most 280 characters: mission control never carries a transcript.
5. `SessionCaps { list: boolean; events: "push" | "poll" | "none"; cancel: boolean; followUp: boolean; deepLink: boolean }`.
6. `SessionAdapter { readonly kind; readonly caps; list(signal?): Promise<AgentSession[]>; get(ref, signal?): Promise<AgentSession | undefined>; follow(ref, after: string | undefined, onEvent, signal?): Promise<string | undefined>; link(ref): string | undefined; cancel(ref): Promise<void>; followUp(ref, text): Promise<void> }` and `class SessionUnsupported extends Error`. `follow` resolves with the adapter's own cursor so a restart resumes.

### T2: Schemas and the state map
Files: `src/mc/schema.ts`, `tests/mc-schema.test.ts`
Model: sonnet
Deps: T1
1. `SESSION_SCHEMA` and `SESSION_EVENT_SCHEMA` are hand-written JSON Schema objects for the T1 shapes, with `additionalProperties: false`, so a field an adapter invents fails validation.
2. `fromRunStatus(status: RunStatus): SessionState` maps `running` and `verifying` to `running`, `needs-info`, `awaiting-approval` and `needs-human` to `waiting`, `shipped` to `succeeded`, `rejected` and `failed` to `failed`, `cancelled` to `cancelled`. It is a `Record<RunStatus, SessionState>`, so a new status fails to compile until it is mapped.
3. Tests: every value of `SessionState` appears in `SESSION_SCHEMA`'s enum and the reverse; a fixture session with an extra key fails `fitsSchema`; `title` of 201 characters fails; every `RunStatus` maps.

### T3: The adapter contract kit
Files: `src/mc/kit.ts`, `src/mc/fake-adapter.ts`, `tests/mc-kit.test.ts`, `tests/mutations.json`
Model: sonnet
Deps: T2
1. `adapterKit(adapter, probe: { ref?: SessionRef })` returns `KitCheck[]` (the type from `src/runtime-kit.ts`): `list` answers within 10 s and every row fits `SESSION_SCHEMA`; every `ref.runtime` equals `adapter.kind`; a `link` is `https:` or absent; a verb whose flag is `false` throws `SessionUnsupported` and a verb whose flag is `true` does not; `follow` with an aborted signal resolves within 1 s.
2. `src/mc/fake-adapter.ts` exports `fakeAdapter(rows, opts)`, an in-memory adapter with settable caps that later slices use in their tests.
3. Tests: the fake passes the kit; a fake that claims `cancel: true` and throws `SessionUnsupported` fails the kit by name; a fake that returns `http://` links fails the kit.
4. Add the two entries under Mutation to `tests/mutations.json`.

## Tests
- `tests/mc-schema.test.ts`: [permanent] schema and state enums agree; unknown keys and long titles fail; every run status maps.
- `tests/mc-kit.test.ts`: [permanent] the kit passes an honest fake and names the check a dishonest one fails.

## Mutation
```json
{"name":"mc: schema allows unknown session keys","file":"src/mc/schema.ts","find":"additionalProperties: false","replace":"additionalProperties: true","test":"tests/mc-schema.test.ts"}
```
```json
{"name":"mc: kit stops checking unsupported verbs","file":"src/mc/kit.ts","find":"instanceof SessionUnsupported","replace":"instanceof Error","test":"tests/mc-kit.test.ts"}
```

## Acceptance
- AC-1: the port declares every verb with a capability flag and an unsupported error: checked by `make test FILES=tests/mc-kit.test.ts` (T1)
- AC-2: the schema and the state type agree, and unknown keys fail: checked by `make test FILES=tests/mc-schema.test.ts` (T2)
- AC-3: the kit passes an honest adapter and fails a dishonest one by name: checked by `make test FILES=tests/mc-kit.test.ts` (T3)

## Non-goals
- NG-1: no adapter, no store, no route, no CLI; those are mc-2 to mc-10.
- NG-2: no transcript, log body or tool output field in either shape; links out to the agent's own view replace them.
- NG-3: no change to `src/ports/agent.ts` or `src/state.ts`.

## Files
- `src/ports/session.ts` (new)
- `src/mc/schema.ts` (new)
- `src/mc/kit.ts` (new)
- `src/mc/fake-adapter.ts` (new)
- `tests/mc-schema.test.ts` (new)
- `tests/mc-kit.test.ts` (new)
- `tests/mutations.json` (edit: add the two entries)
