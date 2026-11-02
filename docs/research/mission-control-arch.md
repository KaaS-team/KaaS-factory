# Mission control for KaaS Factory

Mission control is a thin overview of every agent session a run starts, wherever it runs: run, stage, state, what it needs, cost, approvals, and a link out to the agent's own session view. It is not a session viewer and not a replay. Each coding agent keeps its own view; mission control links to it.

Base: `KaaS-team/KaaS-factory` main at `70ffabf` (v6.2.0). Specs: `specs/mc-1.md` to `specs/mc-10.md`, each passing `bun scripts/lint-planned.ts`.

## 1. What exists

| Piece | Where | Use for mission control |
|---|---|---|
| Run and stage state | `src/state.ts:35-44` `RunStatus` (9 values), `:11` `Stage`, `:405` `listRuns`, `:438` `listEvents`, `:501` `listStageRuns`; `StageRun.session_id`, `cost_usd` (NULL when unknown), `config_hash` | The factory adapter (mc-3) reads these; no schema change |
| CloudEvents bus | `src/core/event.ts`, `bus_events` with `seq` (`src/state.ts:234`, `:659` `busEvents`), outbox HMAC `x-factory-signature: sha256=` | The generic webhook reuses the same header (mc-7) |
| Live updates today | `dashboard/server.ts` `GET /api/stream` (snapshot every 2 s, no ids); `dashboard/plane/runner-routes.ts` `/runner/stream`; AG-UI SSE in `dashboard/plane/integrations.ts` | Replaced for sessions by the #195 `LiveFeed` |
| SSE client | `src/adapters/sse/event-source.ts` (fetch based, Bearer, `Last-Event-ID`) | Cursor stream and `factory sessions follow` |
| Auth and roles | `dashboard/plane/access.ts`: GitHub OAuth cookie (digest stored), break-glass bearer, loopback; roles viewer < approver < operator < owner; `tests/plane-access.test.ts` walks every route | Every mc route names its least role and joins the walk |
| Redaction | `dashboard/plane/operator-detail.ts:6` `OPERATOR_KEYS`, `withheld`; `dashboard/ledger-public.ts:28-38` `scrubText`, `LEAK_TEXT`/`publicLeaks` | Viewer frames and share links; `tokensIn`/`tokensOut` are missing from `OPERATOR_KEYS` today (fixed in mc-10) |
| Secrets | `src/ports/secrets.ts:4` `get(name)`; `machine.json` names `tokenEnv`, validated at boot (`src/machine.ts:18`, `:51`) | Connections name variables, never values (mc-2) |
| Team model | `src/team/schema.ts` Org/Team/Role/Source/Policy; `src/team/resolve.ts` (preference most local, policy strictest, locked items fixed); `src/team/hash.ts` `configHash` (sha256 of canonical JSON, 12 hex, no env) | New `PolicySpec.sessions`; session rows carry the run's hash |
| Steer | `src/integrations/steer.ts:46` `applySteer` (approve, revise, answer, retry, cancel); `:67` `roleFor` | Factory cancel and follow-up (mc-3) |
| Outbound traces | `src/integrations/otel.ts:108` OTLP/JSON per run with `gen_ai.*` | Same convention read inbound (mc-7) |
| ACP | `src/agents/presets/acp.ts`, `acp-client.ts` (ACP v1 over stdio) | ACP adapter (mc-6) |
| Capability ports | `src/ports/sandbox.ts:7-18` caps, `:50` `SandboxUnsupported`; `src/runtime-kit.ts` `KitCheck` | Same pattern for `SessionAdapter` and its kit (mc-1) |

Planned work this builds on, not duplicates:
- #195 (E2.5): `src/api/` `ROUTES` with schemas and roles, `LiveFeed` (ring of 1000, SSE ids, `Last-Event-ID`, `reset`, 15 s heartbeat), `tokenAuth` on `FACTORY_API_TOKEN`, `openapi.json`, `createClient`/`fakeClient`, `factory serve [--fixture]`. Every mc route is a `ROUTES` row.
- #204 `factory tui` reads only through the #195 client; a sessions pane there needs no new API.
- #203 steer inbox and #308 append-only run events: mc-3 reads whichever lands; both keep one writer.
- #196 MCP package: the same `ROUTES` become MCP tools, so an agent can read mission control too.

Name collision: `factory watch` is already the polling daemon (`src/cli.ts:195`). The terminal view is `factory sessions` (list, show, follow, open, cancel, follow-up, connections), plus a pane in `factory tui`.

## 2. What each runtime exposes (verified)

| Runtime | List | Live events | Cancel | Follow-up | Deep link | Source |
|---|---|---|---|---|---|---|
| Factory runs | yes (state.db) | poll `listEvents` | yes (steer) | yes (steer answer or revise) | PR or dashboard run page | this repo |
| Claude Code cloud | no public API (web sidebar only) | push via HTTP hooks and OpenTelemetry | no public API | `claude -p "<msg>" --cloud <id> --output-format json` returns `{ok, session_id, url}` | `https://the session link`; routines `/fire` return `claude_code_session_url` | https://code.claude.com/docs/en/claude-code-on-the-web, https://code.claude.com/docs/en/routines, https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/monitoring-usage |
| Claude Managed Agents | yes | SSE `/v1/sessions/{id}/events/stream` | `user.interrupt` | user message event | none | https://platform.claude.com/docs/en/managed-agents/sessions, https://platform.claude.com/docs/en/managed-agents/events-and-streaming |
| Cursor cloud agents | `GET /v1/agents` | SSE `.../runs/{runId}/stream` with `Last-Event-ID` (400 `invalid_last_event_id`, 410 `stream_expired`); webhook `statusChange` signed `X-Webhook-Signature: sha256=` | `POST .../runs/{runId}/cancel` (409 `run_not_cancellable`) | `POST /v1/agents/{id}/runs`, `"delivery":"steer"`, 409 `agent_busy` | agent `url`, `https://cursor.com/agents/{id}` | https://cursor.com/docs/cloud-agent/api/endpoints, https://cursor.com/docs/cloud-agent/api/webhooks |
| Codex cloud | `codex cloud list --json` (id, url, title, status, updated_at, cursor) | poll `codex cloud status` | not documented | not documented | the task `url` field | https://raw.githubusercontent.com/openai/codex/main/codex-rs/cloud-tasks/src/cli.rs, https://raw.githubusercontent.com/openai/codex/main/codex-rs/cloud-tasks/src/lib.rs |
| Codex local | n/a | `codex exec --json` lines; OpenTelemetry via `[otel]` | process | n/a | none | https://learn.chatgpt.com/docs/non-interactive-mode, https://learn.chatgpt.com/docs/config-file/config-reference |
| ACP agents | sessions this process holds | `session/update` notifications | `session/cancel` | new prompt turn | none | https://agentclientprotocol.com/protocol/prompt-turn, https://agentclientprotocol.com/protocol/transports (stdio; remote is a draft) |
| Own cloud or sandbox | from intake | OTLP/HTTP JSON `invoke_agent` spans, or a signed webhook | no | no | `factory.link` attribute | https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-agent-spans.md (status Development) |
| GitHub | agent tasks REST, check runs, webhooks | webhook | n/a | n/a | task or check URL | https://docs.github.com/en/rest/agent-tasks/agent-tasks, https://docs.github.com/en/rest/checks/runs |

UNVERIFIED and therefore not used: a stable Codex task URL pattern (the adapter uses only the returned `url`); any list or cancel endpoint for Claude Code cloud sessions; a GitHub agent-tasks adapter (documented, left out of the first ten slices).

Shared views of Claude Code cloud sessions do not update live, per the docs above, which is one more reason mission control keeps its own state row and links out rather than embedding.

## 3. Adapter interface (mc-1)

```ts
type SessionState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown";
interface SessionRef { runtime: string; connection: string; externalId: string }
interface SessionCaps { list: boolean; events: "push" | "poll" | "none"; cancel: boolean; followUp: boolean; deepLink: boolean }
interface SessionAdapter {
  readonly kind: string; readonly caps: SessionCaps;
  list(signal?): Promise<AgentSession[]>;
  get(ref, signal?): Promise<AgentSession | undefined>;
  follow(ref, after: string | undefined, onEvent, signal?): Promise<string | undefined>; // returns the cursor
  link(ref): string | undefined;
  cancel(ref): Promise<void>;          // throws SessionUnsupported when caps.cancel is false
  followUp(ref, text): Promise<void>;  // throws SessionUnsupported when caps.followUp is false
}
```

A verb a vendor does not document is a `false` cap and a `SessionUnsupported` sentence telling the user to open the link. `adapterKit` checks every adapter against its own caps.

## 4. Normalized schema

`AgentSession`: `ref`, `title` (200 max), `state`, `repo?`, `issue?`, `stage?`, `startedAt`, `updatedAt`, `link?` (https only), `prUrl?`, `branch?`, `needsYou?` (200 max), `costUsd?: number | null` (null means not reported, never zero), `tokensIn?`, `tokensOut?`, `model?`, `configHash?`.

`SessionEvent`: `ref`, `at`, `kind` (`state`, `stage`, `approval`, `cost`, `link`, `note`, `error`), `state?`, `stage?`, `text?` (one line, 280 max), `costUsd?`.

Both are JSON Schema with `additionalProperties: false`. No field holds a transcript, prompt, tool input or tool output; adapters drop them at the edge. `fromRunStatus` is a `Record<RunStatus, SessionState>` so a new run status fails to compile until mapped.

## 5. Transport

- One table: mc routes are `ROUTES` rows from #195, so OpenAPI, the typed client, the CLI and the access walk see one list.
- SSE: `GET /api/mc/stream` is the #195 `LiveFeed` filtered to `session.*`, with ids, `Last-Event-ID` resume, `reset` and heartbeat.
- WebSocket: `POST /api/mc/ws-ticket` returns a one-use ticket valid 30 s, stored as a digest and bound to the actor; the upgrade takes the ticket or the same-origin session cookie. The bearer token is never accepted in a URL, because URLs land in access logs, history and referrers.
- Terminal: `factory sessions follow` reads the same SSE through the client and resumes on reconnect.
- Parity: `src/api/actions.ts` pairs every route with a CLI verb and a UI page; `tests/api-parity.test.ts` fails on a missing side unless the action is in `PARITY_GAPS`, and fails when a listed gap closes, so the list only shrinks. This covers workflows, settings and connections, not only sessions.

## 6. Auth

- Browser and phone: the existing plane session (GitHub OAuth, cookie id, digest stored), roles viewer to owner. Phones keep the existing QR pairing and Web Push.
- CLI and scripts: `FACTORY_API_TOKEN` from the environment through #195 `tokenAuth`; there is no `--token` flag.
- Roles: list and stream are viewer; cancel and follow-up take `PolicySpec.sessions.follow_up_role` (default operator); connection reads and tests are operator; connection writes are owner.
- Inbound intake: each connection has its own secret; an unknown name and a bad credential return the same `404`.
- Share links: one run, read-only, expiring (7 days max), revocable, secret in the URL fragment, traded once for a path-scoped `HttpOnly; Secure; SameSite=Strict` cookie, data passed through `withoutOperatorDetail`, `scrubText` and `publicLeaks`, gated by `sessions.share_links`.

## 7. Secrets and redaction

1. Keys live in the environment; `machine.json` `sessions.connections` names the variable (`tokenEnv`, `webhookSecretEnv`). A literal value is refused at boot with a sentence.
2. Keys go only in the `Authorization` header, never a URL, argv or log line. CLI adapters (Claude Code, Codex) run with argv only and an env of `PATH` and `HOME`; they use the user's own CLI login.
3. `redactText` removes bearer and basic values, `ghp_`-style and `github_pat_` tokens, `sk-` keys, AWS key ids, chat tokens, JWTs, URL userinfo and secret-named query parameters, plus every secret value this process resolved.
4. Every stored row goes through `redactRow` and `SESSION_SCHEMA`; the only logger under `src/mc/` redacts.
5. Viewers never see cost, tokens, model or host (`OPERATOR_KEYS`, applied to JSON, SSE and WebSocket frames alike).
6. Structural test: no file under `src/mc/` calls `fetch` outside `safe-fetch.ts`, `console` outside `log.ts`, or reads the environment outside `connections.ts`.

## 8. Offline behaviour

The store keeps the last known rows per connection in `FACTORY_HOME/mc.db`. A failed poll or stream marks that connection's rows with `stale_since` and backs off from 15 s to 5 min with jitter; rows are never deleted for being unreachable. The page and `factory sessions` show an offline badge with the time. Cursors are saved per session, so a restart resumes streams instead of replaying. With `factory serve` down, the CLI reports the server unreachable and exits non-zero; it never falls back to reading the store directly, so CLI and UI never disagree.

## 9. Team model and config hash

- A session belongs to a run (repo, issue), and a repo belongs to a team, so the existing team scoping decides who sees it.
- `RoleSpec.harness` and `runtime` decide which adapter will own a stage's cloud session; the factory adapter emits a child row with that runtime and the stage's `session_id`, and the hub merges it with the vendor's row.
- New `PolicySpec.sessions { follow_up_role, share_links, retain_days }`, resolved strictest-wins (higher role, `false` over `true`, smaller retention), lockable at org level, included in `configHash`.
- Connection names, kinds, URLs and variable names enter the hash input; values never do, matching `src/team/hash.ts`, which reads no env.
- Team roles (agent harness and model) and plane roles (viewer to owner) stay separate concepts.

## 10. Threat model

| Threat | Control | Slice |
|---|---|---|
| A key or session secret committed to a public repo | Connections live in `machine.json` under `FACTORY_HOME`, never in repo or team files; values refused; fixtures hand-written from docs | mc-2, mc-5 |
| Token in a URL, log, argv or error | Header-only auth, `safeFetch` refuses a URL containing the secret, argv-only CLI calls, redacting logger, redacted errors, no `--token` flag, WS ticket instead of token | mc-2, mc-4, mc-8, mc-9 |
| SSRF through a configured or vendor-supplied URL | https only, per-connection host allow-list, userinfo refused, private, loopback, link-local, metadata and ULA addresses refused unless the connection allows it, no redirects, 10 s timeout, 1 MiB cap; deep links accepted only from the vendor's own origin | mc-2, mc-4, mc-5 |
| Vendor text carrying secrets or injected content to viewers | Schema with no extra keys, length caps, `redactRow`, transcripts and tool bodies dropped at the adapter | mc-1, mc-2, mc-4 to mc-7 |
| Forged inbound events | HMAC over raw bytes with constant-time compare, 64 KiB cap before hashing, 5 minute replay window, per-connection secret, uniform 404 | mc-5, mc-7 |
| Operator detail reaching a viewer or a share | `OPERATOR_KEYS` on every response and frame; share data scrubbed and leak-checked | mc-8, mc-10 |
| Share link leaking or living forever | Fragment secret, digest stored, path-scoped cookie, 7 day cap, revoke, audit log, policy gate | mc-10 |
| Unauthorized cancel or follow-up | Least role per route, policy role, CSRF same-origin JSON from the existing plane, audit | mc-8 |
| Reverse tabnabbing from a deep link | `target="_blank" rel="noopener noreferrer"` | mc-10 |

Residual: DNS can change between the address check and the connect (no pinning, NG in mc-2); the host allow-list is the primary control. A user with operator role can still paste a secret into a follow-up text; it is redacted before storage but reaches the vendor, which is the user's intent.

## 11. Slices

| Spec | Title | Risk | Blocked by | Main files |
|---|---|---|---|---|
| mc-1 | Session port, schema and contract kit | low | #195 T1 | `src/ports/session.ts`, `src/mc/schema.ts`, `src/mc/kit.ts`, `src/mc/fake-adapter.ts` |
| mc-2 | Redaction, outbound guard, connections | high | mc-1 | `src/mc/redact.ts`, `src/mc/safe-fetch.ts`, `src/mc/connections.ts`, `src/machine.ts` |
| mc-3 | Factory runs as sessions | medium | mc-1 | `src/mc/adapters/factory.ts` |
| mc-4 | Claude Code cloud, hooks, Managed Agents | medium | mc-2, mc-3 | `src/mc/adapters/claude-code*.ts`, `managed-agents.ts` |
| mc-5 | Cursor cloud agents and webhook | medium | mc-2 | `src/mc/adapters/cursor*.ts` |
| mc-6 | Codex cloud and ACP | medium | mc-2 | `src/mc/adapters/codex.ts`, `acp.ts` |
| mc-7 | Own-cloud intake: OTLP and signed webhook | high | mc-2 | `src/mc/adapters/otlp.ts`, `webhook.ts`, `src/mc/intake.ts` |
| mc-8 | Hub, store, routes, SSE and WebSocket, session policy | high | #195, mc-3 | `src/mc/{store,hub,log,routes,socket}.ts`, `src/api/routes.ts`, `src/api/serve.ts`, `src/team/{schema,resolve}.ts` |
| mc-9 | `factory sessions` and the API parity table | medium | mc-8 | `src/api/actions.ts`, `src/mc/cli.ts`, `src/cli.ts`, `src/help.ts` |
| mc-10 | Sessions page and read-only share links | high | mc-8 | `dashboard/public/lib/sessions.js`, `dashboard/plane/shares.ts`, `dashboard/server.ts`, `dashboard/plane/operator-detail.ts` |

Parallel order: mc-1, then mc-2 and mc-3 together, then mc-4 to mc-7 and mc-8 together, then mc-9 and mc-10 together.

Disjoint files: every slice owns its files except `tests/mutations.json`, the one shared append-only list each slice adds entries to; parallel PRs will need a trivial rebase there. `src/cli.ts` (976 lines) and `dashboard/server.ts` (736 lines) get one dispatch or mount line each, to stay inside their quality baselines.

Left out on purpose: a GitHub agent-tasks adapter, OTLP protobuf or gRPC, remote ACP, launching vendor agents from mission control, and any embedded view or transcript.
