<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Blocked by: mc-2 and mc-3 (not filed yet)
Deps: none
Epic: E14 Mission control
Milestone: Phase 7 mission control
Runner: factory

## Risk: medium

## Why
A Claude Code cloud session has its own live view at `https://claude.ai/code/<session-id>`, and mission control must link to it, not copy it. Claude Code exposes no public list or cancel call for cloud sessions, so the adapter is honest about it: it records the session id and URL the CLI or a routine returns, accepts follow-ups through the CLI where the docs allow them, and reads status and cost from the hooks and OpenTelemetry signals Claude Code already emits. A team on the Managed Agents API gets a second kind with a real event stream and an interrupt.

## Today
- `src/dispatch.ts` `factory routine` prints a Claude Code cloud routine; nothing records the session it fires.
- `src/agents/presets/` runs Claude Code locally; `StageRunResult.sessionId` (`src/ports/agent.ts:107`) keeps the session id.
- Verified behaviour (primary sources):
  - `claude --cloud "<task>"` starts a cloud session; `claude -p "<msg>" --cloud <session-id> --output-format json` sends a follow-up and returns `{ok, session_id, url}`; `stream-json` is not supported for cloud sessions; sessions are listed only in the web sidebar. https://code.claude.com/docs/en/claude-code-on-the-web
  - A routine's `/fire` endpoint returns `claude_code_session_id` and `claude_code_session_url`. https://code.claude.com/docs/en/routines
  - HTTP hooks POST each hook event as JSON to a URL. https://code.claude.com/docs/en/hooks
  - OpenTelemetry metrics and events carry `session.id` and cost (`claude_code.cost.usage`, `api_request` with `cost_usd`). https://code.claude.com/docs/en/monitoring-usage
  - Managed Agents sessions stream events over SSE at `/v1/sessions/{id}/events/stream` and accept a `user.interrupt` event. https://platform.claude.com/docs/en/managed-agents/sessions and https://platform.claude.com/docs/en/managed-agents/events-and-streaming

## Change
### T1: The cloud session adapter
Files: `src/mc/adapters/claude-code.ts`, `tests/mc-adapter-claude-code.test.ts`
Model: opus
1. `claudeCodeAdapter(deps: { store: SessionNotes; run: (argv: string[], env: Record<string, string>) => Promise<{code: number; stdout: string}> })` with `kind: "claude-code"` and caps `{list: false, events: "push", cancel: false, followUp: true, deepLink: true}`. `SessionNotes` is the small `{record(session), get(ref)}` interface the hub store implements in mc-8; the test uses a map.
2. `note(fromCli | fromRoutine)` parses the JSON the CLI or `/fire` returns, keeps only `session_id` (matching `^[A-Za-z0-9_-]{8,128}$`) and the URL, and refuses a URL whose origin is not `https://claude.ai`.
3. `link(ref)` is `https://claude.ai/code/<externalId>` after the same id check.
4. `followUp(ref, text)` runs `claude -p <text> --cloud <id> --output-format json` with argv, never a shell string, and an env holding only `PATH` and `HOME`; the text goes in argv, the key never does (the CLI uses the user's own login).
5. `list` and `cancel` throw `SessionUnsupported` with the sentence "Claude Code lists and stops cloud sessions only in its own view; open the link".
6. Tests: the adapter passes `adapterKit`; a routine reply with a foreign URL is refused; an id with `/` is refused before any call; the follow-up argv has no shell and no secret.

### T2: Hook and telemetry intake
Files: `src/mc/adapters/claude-code-signals.ts`, `tests/mc-claude-code-signals.test.ts`
Model: sonnet
Deps: T1
1. `fromHook(body)` maps a hook POST to `SessionEvent`s: `SessionStart` to `state: running`, `Stop` to `state: waiting` with `text` "turn finished", `SessionEnd` to `succeeded`, `Notification` to `approval` with its message cut to 280 characters and passed through `redactText`. Any other event is dropped; tool inputs and outputs are never kept.
2. `fromOtelLog(record)` maps an `api_request` log with `session.id` to a `cost` event carrying `cost_usd`.
3. Tests: each mapped hook yields its event; a `PreToolUse` body with a command line yields nothing; a notification holding a bearer value comes out redacted.

### T3: Managed Agents kind
Files: `src/mc/adapters/managed-agents.ts`, `tests/mc-adapter-managed-agents.test.ts`, `tests/mutations/mc-claude-code-link-accepts-any-id.json`, `tests/mutations/mc-hook-keeps-tool-input.json`
Model: sonnet
Deps: T1
1. `managedAgentsAdapter(conn, deps: { fetch: typeof safeFetch; key: () => string })` with `kind: "managed-agents"`, caps `{list: true, events: "push", cancel: true, followUp: true, deepLink: false}`; every call goes through `safeFetch` with the connection's host allow-list and the key only in the auth header.
2. `follow` reads `/v1/sessions/{id}/events/stream` and maps status events to `state` and usage to `cost`; message bodies are dropped. `cancel` sends `user.interrupt`; `followUp` sends a user message.
3. Tests with a scripted fake fetch: the kit passes; the stream maps; a message body never reaches an event.
4. Save each entry under Mutation as its own file (`tests/mutations/mc-claude-code-link-accepts-any-id.json`, `tests/mutations/mc-hook-keeps-tool-input.json`), a single JSON object each. Never edit the old mutations list.

## Tests
- `tests/mc-adapter-claude-code.test.ts`: [permanent] kit, id and URL checks, argv-only follow-up.
- `tests/mc-claude-code-signals.test.ts`: [permanent] hook and telemetry mapping drops tool bodies and redacts.
- `tests/mc-adapter-managed-agents.test.ts`: [permanent] kit and stream mapping with no message bodies.

## Mutation
```json
{"name":"mc: claude-code link accepts any id","file":"src/mc/adapters/claude-code.ts","find":"if (!SESSION_ID.test(id))","replace":"if (false)","test":"tests/mc-adapter-claude-code.test.ts"}
```
```json
{"name":"mc: hook keeps tool input","file":"src/mc/adapters/claude-code-signals.ts","find":"if (!MAPPED.has(body.hook_event_name)) return []","replace":"if (false) return []","test":"tests/mc-claude-code-signals.test.ts"}
```

## Acceptance
- AC-1: a Claude Code cloud session shows as a row that links to its own view, with follow-up by argv and list and cancel declared unsupported: checked by `make test FILES=tests/mc-adapter-claude-code.test.ts` (T1)
- AC-2: hooks and telemetry update state and cost without keeping tool bodies: checked by `make test FILES=tests/mc-claude-code-signals.test.ts` (T2)
- AC-3: the Managed Agents kind follows, interrupts and follows up through the guarded fetch: checked by `make test FILES=tests/mc-adapter-managed-agents.test.ts` (T3)

## Non-goals
- NG-1: no scraping of the web sidebar and no use of any undocumented endpoint.
- NG-2: no Remote Control relay; its view stays in the Claude apps.
- NG-3: no hook receiver route; mc-7 owns inbound endpoints and calls `fromHook`.

## Files
- `src/mc/adapters/claude-code.ts` (new)
- `src/mc/adapters/claude-code-signals.ts` (new)
- `src/mc/adapters/managed-agents.ts` (new)
- `tests/mc-adapter-claude-code.test.ts` (new)
- `tests/mc-claude-code-signals.test.ts` (new)
- `tests/mc-adapter-managed-agents.test.ts` (new)
- `tests/mutations/mc-claude-code-link-accepts-any-id.json` (new)
- `tests/mutations/mc-hook-keeps-tool-input.json` (new)
