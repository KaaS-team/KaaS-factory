<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Blocked by: mc-2 (not filed yet)
Deps: none
Epic: E14 Mission control
Milestone: Phase 7 mission control
Runner: factory

## Risk: medium

## Why
Codex cloud tasks and ACP agents are the two remaining integration targets, and both are thinner than Cursor. Codex cloud lists tasks and their status through its CLI with JSON output, with no documented cancel or follow-up. ACP is a local stdio protocol: it streams `session/update` notifications and accepts `session/cancel`, so a factory stage that drives an ACP agent can report it as a session. Each adapter declares only the verbs its source documents.

## Today
- `src/agents/presets/acp.ts` and `src/agents/presets/acp-client.ts` speak ACP v1 over stdio for a stage.
- `docs/agent-research/codex` and `docs/agent-research/acp` record the local CLIs.
- Verified behaviour (primary sources):
  - `codex cloud list --json` prints tasks with `id`, `url`, `title`, `status` (`pending`, `ready`, `applied`, `error`), `updated_at` and a page cursor; `codex cloud status <id>` reads one. https://raw.githubusercontent.com/openai/codex/main/codex-rs/cloud-tasks/src/cli.rs and https://raw.githubusercontent.com/openai/codex/main/codex-rs/cloud-tasks/src/lib.rs
  - `codex exec --json` prints `thread.started`, `turn.completed` with usage, and `item.*` lines. https://learn.chatgpt.com/docs/non-interactive-mode
  - Codex exports OpenTelemetry when `[otel]` is set in its config. https://learn.chatgpt.com/docs/config-file/config-reference
  - ACP `session/update` carries `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan` and others; `session/cancel` stops a turn; the stop reason ends a prompt turn. https://agentclientprotocol.com/protocol/prompt-turn
  - ACP transport is stdio; a remote transport is a draft. https://agentclientprotocol.com/protocol/transports
- UNVERIFIED: a stable Codex task web URL pattern. The adapter uses only the `url` the CLI returns.

## Change
### T1: The Codex cloud adapter
Files: `src/mc/adapters/codex.ts`, `tests/mc-adapter-codex.test.ts`, `tests/fixtures/mc/codex/list.json`
Model: sonnet
1. `codexAdapter(deps: { run: (argv: string[], env: Record<string, string>) => Promise<{code: number; stdout: string}> })` with `kind: "codex"`, caps `{list: true, events: "poll", cancel: false, followUp: false, deepLink: true}`.
2. `list` runs `codex cloud list --json` (argv only, env `PATH` and `HOME`), follows the cursor up to 5 pages, and maps `pending` to `running`, `ready` to `waiting` (a diff waits for review), `applied` to `succeeded` and `error` to `failed`; an unknown status is `unknown`.
3. `link` is the task's `url` only when it is https; `follow` polls `codex cloud status <id>` every 15 s and emits a `state` event on change.
4. `cancel` and `followUp` throw `SessionUnsupported` with the sentence "Codex cloud has no documented cancel or follow-up; open the link".
5. Tests with a scripted runner: the kit passes; every status maps; a non-https URL gives no link; a non-zero exit becomes an `error` event, never a crash.

### T2: The ACP adapter
Files: `src/mc/adapters/acp.ts`, `tests/mc-adapter-acp.test.ts`, `tests/mutations/mc-codex-ready-not-shown-as-waiting.json`, `tests/mutations/mc-acp-keeps-message-chunks.json`
Model: sonnet
1. `acpAdapter(deps: { sessions: () => AcpLive[] })` reads the sessions the ACP preset holds open in this process, with `kind: "acp"`, caps `{list: true, events: "push", cancel: true, followUp: false, deepLink: false}`.
2. `fromAcpUpdate(update)` maps `plan` to a `note` with the entry count, `tool_call` to a `note` with the tool kind only, and a prompt stop reason to `state` (`end_turn` to `waiting`, `cancelled` to `cancelled`, `refusal` to `failed`); message chunks are dropped.
3. `cancel` sends `session/cancel` through the preset's client.
4. Tests: the kit passes over a fake live session; each update kind maps; a message chunk yields nothing.
5. Save each entry under Mutation as its own file (`tests/mutations/mc-codex-ready-not-shown-as-waiting.json`, `tests/mutations/mc-acp-keeps-message-chunks.json`), a single JSON object each. Never edit the old mutations list.

## Tests
- `tests/mc-adapter-codex.test.ts`: [permanent] kit, status map, link only from https `url`, exit errors as events.
- `tests/mc-adapter-acp.test.ts`: [permanent] kit and update mapping with message bodies dropped.

## Mutation
```json
{"name":"mc: codex ready not shown as waiting","file":"src/mc/adapters/codex.ts","find":"ready: \"waiting\"","replace":"ready: \"running\"","test":"tests/mc-adapter-codex.test.ts"}
```
```json
{"name":"mc: acp keeps message chunks","file":"src/mc/adapters/acp.ts","find":"case \"agent_message_chunk\": return []","replace":"case \"agent_message_chunk\": return [{ kind: \"note\", text: String(u.content) }]","test":"tests/mc-adapter-acp.test.ts"}
```

## Acceptance
- AC-1: Codex cloud tasks list and poll through the CLI with argv only, and declare cancel and follow-up unsupported: checked by `make test FILES=tests/mc-adapter-codex.test.ts` (T1)
- AC-2: ACP sessions report state and stop through `session/cancel` with no message bodies: checked by `make test FILES=tests/mc-adapter-acp.test.ts` (T2)

## Non-goals
- NG-1: no Codex web API call; the CLI is the documented surface.
- NG-2: no remote ACP transport until it leaves draft.
- NG-3: no change to `src/agents/presets/acp*.ts` beyond what T2 reads through `deps`.

## Files
- `src/mc/adapters/codex.ts` (new)
- `src/mc/adapters/acp.ts` (new)
- `tests/mc-adapter-codex.test.ts` (new)
- `tests/mc-adapter-acp.test.ts` (new)
- `tests/fixtures/mc/codex/list.json` (new)
- `tests/mutations/mc-codex-ready-not-shown-as-waiting.json` (new)
- `tests/mutations/mc-acp-keeps-message-chunks.json` (new)
