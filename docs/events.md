# Events and minions

The factory speaks CloudEvents 1.0 (structured JSON). It emits an event at each engine point, sends
them to the sinks you configure, accepts other apps' events on `POST /events`, and lets those events
start workflows and minions.

## The envelope

```json
{
  "specversion": "1.0",
  "id": "5f0c...",
  "source": "factory/acme/widgets",
  "type": "factory.pr.opened",
  "subject": "issue/12",
  "time": "2026-10-11T09:30:00.000Z",
  "data": { "repo": "acme/widgets", "issue": 12, "url": "https://github.com/acme/widgets/pull/40", "head": "factory/12" }
}
```

## Types

`EVENT_TYPES` in `src/core/event.ts` is the catalogue. A test fails when the code emits a type that is
missing from it, or when a factory type is never emitted.

| Factory emits | When |
|---|---|
| `factory.issue.ready` | the watcher picks up a `factory:ready` issue |
| `factory.step.started` / `.completed` / `.failed` | each workflow step |
| `factory.issue.parked` | a run stops for a human (needs-info, needs-human, awaiting-approval, failed) |
| `factory.pr.opened` | the pr step opens a PR |
| `factory.pr.merged` | the factory or an operator merges it |
| `factory.run.completed` | a run ends, with its outcome |
| `factory.minion.completed` | a minion finishes, `ok` true or false |

Other apps' types, the only ones `POST /events` accepts: `tasks.task.ready`, `tasks.task.updated`,
`wiki.page.updated`, `wiki.question.unanswered`, `decisions.decision.proposed`,
`decisions.conflict.detected`, `skills.skill.proposed`, `skills.skill.promoted`,
`audit.report.completed`.

## Sinks

```json
{
  "events": {
    "sinks": [{ "url": "https://kaas.example/events", "secretEnv": "KAAS_EVENTS_SECRET", "types": ["factory.pr.merged"] }],
    "inboundSecretEnv": "FACTORY_EVENTS_SECRET"
  }
}
```

Every event lands in the SQLite outbox first (`bus_events`), with one delivery row per sink whose
`types` match (no `types` means all). The watcher POSTs due deliveries with
`content-type: application/cloudevents+json`. A failure waits 2 s, then 4 s, 8 s, up to an hour, and
after 8 attempts the delivery is dead until `factory events replay <id>`.

`secretEnv` names an environment variable. The config never holds the secret, and the bus never logs
it. An unset variable is a failed attempt that sends nothing.

## Signature

`x-kaas-signature: sha256=<hex>`, where hex is HMAC-SHA256 of the raw body under the shared secret.
The same header signs outbound deliveries and authenticates inbound ones.

## Inbound: `POST /events`

The dashboard serves it. It is off (404) until the variable `events.inboundSecretEnv` names (default
`FACTORY_EVENTS_SECRET`) is set. A request whose signature fails is 401. A factory or unknown type is
202 and ignored, so nobody outside can fake a merge. A new id is stored (201), and a repeated id is
acknowledged (200) and not stored again. The route needs no dashboard token, as GitHub's webhook does
not, so it can be reached from off the box.

The watcher hands each stored event to the same subscribers as its own emits.

## Workflows on an event

```yaml
on:
  event: wiki.page.updated     # or a list of types
```

The event files one issue per event id, titled `<type>: <subject>`, with the event data in its body.
A factory event files it as `factory:ready`. Another app's event (from `POST /events`, or a minion's
answer) files it with no label: the signature proves who sent it, not that its data is safe to run,
so a maintainer reads it and adds `factory:ready`, and pickup checks that person's role as it does for
any issue. A workflow that is not the repo's own is recorded on the issue, so pickup runs it.

## Minions

A minion is one agent run with no issue and no PR. Each lives in `.factory/minions/<name>.yml`:

```yaml
name: wiki-refresh                # must match the file name
description: Say which wiki page a task change makes stale.
on:
  event: tasks.task.updated       # or cron: "0 6 * * 1" with optional tz
agent: claude                     # optional, from config.agents
skill: wiki-check                 # optional, .claude/skills/<skill>/SKILL.md goes before the prompt
prompt: Answer with one JSON object.
mcp: [docs]                       # optional, names in .factory/mcp.json
emit: wiki.page.updated           # optional, another app's type; data is the JSON answer
budgetUsd: 0.5                    # optional, default maxBudgetUsd.retro
runtime: local                    # the only runtime today
```

The watcher checks every minion when it starts and refuses to run with a bad one. A run does not
start while intake is paused or the repo's or machine's daily spend cap is hit. Its spend is recorded
as stage `minion:<name>` on issue 0, in SQLite, the shared ledger and the machine tally, so it counts
toward those caps. It emits `factory.minion.completed` and then its `emit` type, and never wakes on
an event it emitted.

A minion runs with the triage stage's tools and allow-list: read-only shell, writes only under
`.factory/runs/issue-0/`, and only the MCP servers it names. Its working directory is its own
workspace, not a checkout. The triggering event goes into the prompt between
`<untrusted-event-data>` tags, marked as data never to obey.
`template/.factory/minions/wiki-refresh.yml.example` is a starting point.

## CLI

- `factory minion list --repo-dir .` lists and checks the minions.
- `factory minion run <name> [--event <file.json>]` runs one now.
- `factory events tail [--limit N] [--json]` shows recent events in and out, with delivery status.
- `factory events replay <id>` sends one event to its sinks again.
