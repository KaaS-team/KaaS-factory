# Integrations

Everything the factory plugs into has a folder under `integrations/` with one `manifest.json`. A
manifest names the kind (tracker, runtime, agent, notifier or intake), the env var names it reads, how
to turn it on, its module and its contract test. Values never go in a manifest, only names.

The table below is generated from the manifests (`bun scripts/gen-integrations-doc.ts`), and
`tests/integrations.test.ts` fails when it drifts, when a manifest points at a file that does not
exist, or when a tracker or runtime kind has no manifest. Where a token's name is set by `tokenEnv`,
the table shows the name the examples use.

<!-- integrations-table:start -->
| Integration | Kind | What it does | Turn it on | Env keys | On by default | Live test keys |
| --- | --- | --- | --- | --- | --- | --- |
| `asana` | tracker | Asana tasks in one project. | `"tracker": {"kind": "asana", "workspace": "...", "project": "...", "tokenEnv": "ASANA_TOKEN"}` | `ASANA_TOKEN` | no | `FACTORY_LIVE_ASANA_WORKSPACE`, `FACTORY_LIVE_ASANA_PROJECT`, `FACTORY_LIVE_ASANA_TOKEN` |
| `clickup` | tracker | ClickUp tasks in one list. | `"tracker": {"kind": "clickup", "workspace": "...", "list": "...", "tokenEnv": "CLICKUP_API_TOKEN"}` | `CLICKUP_API_TOKEN` | no | `FACTORY_LIVE_CLICKUP_WORKSPACE`, `FACTORY_LIVE_CLICKUP_LIST`, `FACTORY_LIVE_CLICKUP_TOKEN` |
| `github` | tracker | Issues and PRs on GitHub through the gh CLI. | the default; `gh auth login` on the machine | none | yes | n/a |
| `http` | tracker | Any tracker behind Tracker API v1, public or private (docs/tracker-api.md). | `"tracker": {"kind": "http", "url": "...", "tokenEnv": "TRACKER_TOKEN"}` | `TRACKER_TOKEN` | no | n/a |
| `jira` | tracker | Jira Cloud or Data Center issues in one project. | `"tracker": {"kind": "jira", "url": "...", "project": "SHOP", "tokenEnv": "JIRA_API_TOKEN"}` | `JIRA_API_TOKEN` | no | `FACTORY_LIVE_JIRA_URL`, `FACTORY_LIVE_JIRA_PROJECT`, `FACTORY_LIVE_JIRA_TOKEN` |
| `linear` | tracker | Linear issues in one team. | `"tracker": {"kind": "linear", "team": "ENG", "tokenEnv": "LINEAR_API_KEY"}` | `LINEAR_API_KEY` | no | `FACTORY_LIVE_LINEAR_KEY`, `FACTORY_LIVE_LINEAR_TEAM` |
| `plane` | tracker | Plane work items in one project, cloud or self-hosted. | `"tracker": {"kind": "plane", "workspace": "...", "project": "...", "tokenEnv": "PLANE_API_KEY"}` | `PLANE_API_KEY` | no | `FACTORY_LIVE_PLANE_WORKSPACE`, `FACTORY_LIVE_PLANE_PROJECT`, `FACTORY_LIVE_PLANE_KEY` |
| `agent37` | runtime | Runs on an Agent37 instance. | `{"kind": "agent37", "instance": "...", "tokenEnv": "AGENT37_API_KEY"}` in machine.json | `AGENT37_API_KEY` | no | n/a |
| `codespaces` | runtime | Runs in a GitHub Codespace through gh. | `{"kind": "codespaces", "codespace": "...", "tokenEnv": "GH_TOKEN"}` in machine.json | `GH_TOKEN` | no | n/a |
| `docker` | runtime | Runs each command in a throwaway container. | `{"kind": "docker", "image": "..."}` in machine.json | none | no | n/a |
| `http-sandbox` | runtime | Any hosted sandbox behind the sandbox HTTP protocol, public or private. | `{"kind": "http", "url": "...", "tokenEnv": "SANDBOX_TOKEN"}` in machine.json | `SANDBOX_TOKEN` | no | `FACTORY_LIVE_SANDBOX_URL`, `FACTORY_LIVE_SANDBOX_TOKEN` |
| `local` | runtime | Runs gates and checks in the worktree on this machine. | the default | none | yes | n/a |
| `lwpr` | runtime | Runs on a build box through the lwpr CLI. | `{"kind": "lwpr"}` in machine.json | none | no | n/a |
| `microsandbox` | runtime | Runs in a microsandbox microVM. | `{"kind": "microsandbox", "image": "..."}` in machine.json | none | no | n/a |
| `pool` | runtime | Spreads commands over named runtimes within their minute budgets. | `{"kind": "pool", "members": [...]}` in machine.json | none | no | n/a |
| `ssh` | runtime | Copies the worktree to a box over ssh and runs there. | `{"kind": "ssh", "host": "...", "dir": "..."}` in machine.json | none | no | `FACTORY_LIVE_SSH_HOST`, `FACTORY_LIVE_SSH_DIR` |
| `wrap` | runtime | Runs under any launcher argv, such as a Firecracker or gVisor wrapper. | `{"kind": "wrap", "argv": ["...", "{cmd}"]}` in machine.json | none | no | `FACTORY_LIVE_WRAP_ARGV` |
| `a2a` | agent | Lets another agent start and steer a task over A2A (agent card plus JSON-RPC). | set `FACTORY_A2A_TOKEN` on the plane | `FACTORY_A2A_TOKEN` | no | n/a |
| `acp` | agent | Drives any Agent Client Protocol agent as a stage agent. | an agent with `"preset": "acp", "command": [...]` in config | none | no | n/a |
| `ag-ui` | notifier | Streams a run as AG-UI events for an agent front end. | set `FACTORY_AGUI=1` on the plane | `FACTORY_AGUI` | no | n/a |
| `event-sinks` | notifier | Posts each factory CloudEvent, signed, to the URLs config names. | `"events": {"sinks": [{"url": "...", "secretEnv": "..."}]}` | none | no | n/a |
| `github-checks` | notifier | One GitHub check run per step on the issue branch. | set `FACTORY_CHECKS_TOKEN` (a token with checks:write) on the watcher | `FACTORY_CHECKS_TOKEN` | no | n/a |
| `mcp-notifier` | notifier | Calls a tool on an MCP server with each progress note. | set `FACTORY_MCP_NOTIFY_URL` and `FACTORY_MCP_NOTIFY_TOOL` on the watcher | `FACTORY_MCP_NOTIFY_URL`, `FACTORY_MCP_NOTIFY_TOOL`, `FACTORY_MCP_TOKEN` | no | n/a |
| `otel` | notifier | Exports one OpenTelemetry trace per run, a gen_ai span per stage. | set `OTEL_EXPORTER_OTLP_ENDPOINT` on the watcher | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | no | n/a |
| `events-inbound` | intake | Takes signed CloudEvents from other apps on POST /events. | set `FACTORY_EVENTS_SECRET` on the plane | `FACTORY_EVENTS_SECRET` | no | n/a |
| `github-webhook` | intake | Wakes the watcher on a signed GitHub webhook delivery. | set `FACTORY_WEBHOOK_SECRET` on the plane | `FACTORY_WEBHOOK_SECRET` | no | n/a |
| `linear-agent` | intake | Delegate a Linear issue to the factory as an agent session; steer it from the session. | a Linear OAuth app (actor=app); set both keys on the plane and the watcher | `LINEAR_AGENT_TOKEN`, `LINEAR_WEBHOOK_SECRET` | no | n/a |
| `mcp-events` | intake | Asks a tool on an MCP server for new CloudEvents every minute. | set `FACTORY_MCP_EVENTS_URL` and `FACTORY_MCP_EVENTS_TOOL` on the watcher | `FACTORY_MCP_EVENTS_URL`, `FACTORY_MCP_EVENTS_TOOL`, `FACTORY_MCP_TOKEN` | no | n/a |
| `slack` | intake | Start and steer a task from a Slack assistant thread. | a Slack app with the assistant view; set both keys on the plane and the watcher | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | no | n/a |
<!-- integrations-table:end -->

## Steering from anywhere

Every surface steers through one path, `src/integrations/steer.ts`: a message becomes a start, a
ready label or an inbox action, and the action is a signed comment on the issue before anything else
happens. So a Linear session, a Slack thread, an A2A client and the dashboard all leave the same
record on the tracker, and a runner that only polls the tracker obeys each of them.

A message reads `approve`, `revise <what>`, `answer <text>`, `retry` or `cancel`, with an optional
`#42`. Free text in a thread already bound to an issue is an answer; anywhere else it starts a task.

- **Linear.** Install a Linear OAuth app with `actor=app` and the `app:assignable` and
  `app:mentionable` scopes, point its webhook at `POST /integrations/linear` on the plane, and set
  `LINEAR_AGENT_TOKEN` and `LINEAR_WEBHOOK_SECRET`. Delegating an issue opens an agent session: the
  plane acks at once, posts a first thought, and starts the run. The watcher then posts each step as
  an activity and keeps the session's plan and PR link current.
- **Slack.** Create a Slack app with the assistant view, point its event subscription at
  `POST /integrations/slack`, and set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. A message in an
  assistant thread starts a task; later messages in that thread steer it.
- **A2A.** Set `FACTORY_A2A_TOKEN`. The plane serves its agent card at
  `/.well-known/agent-card.json` and takes `message/send` and `tasks/get` on `POST /a2a`.
- **AG-UI.** Set `FACTORY_AGUI=1`. `GET /api/agui/<issue>` streams that issue's run as AG-UI
  events, behind the dashboard's viewer role.

A2A and AG-UI are off unless a user turns them on.

## Progress back out

The watcher's bus hands each factory event to every notifier whose keys are set: Linear activities,
the Slack thread, an MCP tool call, one GitHub check run per step, and one OpenTelemetry trace per run
with a `gen_ai` span per stage. A notifier that is down costs a log line, never a run.

## The `uses: mcp` step

A workflow step can call a tool on an HTTP MCP server named in `.factory/mcp.json`:

```yaml
notify: { uses: mcp, label: factory:notifying, run: tickets/close_ticket, next: pr }
```

The tool gets `{issue, title}` and spends no tokens. An error from the tool fails the run with a comment
on the issue. Header values may use `${VAR}`, read from the runner's env, so a token stays out of the file.

## Adding an integration

Any company, public or private, adds one by pull request: a folder under `integrations/` with its
manifest, the module, and a contract test that runs the port's shared contract (`trackerContract` or
`executionContract` in `tests/ports/`). A system that should stay private needs no code in this repo:
put it behind Tracker API v1 (`docs/tracker-api.md`) or the sandbox HTTP protocol
(`docs/runtimes.md`), or keep the integration in a fork.

## Live suites

`tests/live-trackers.test.ts` and `tests/live-runtimes.test.ts` run the same contracts against a real
workspace or box. Each vendor runs only when its keys (the last column) are set, and is skipped with
the missing key's name otherwise, so the gate never needs them.
