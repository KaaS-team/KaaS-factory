# Workflows

An issue runs a workflow: named steps, each a built-in step type, the label it holds while it runs,
and where it goes next. `config.workflow` names it (default `feature-to-pr`). The runner reads
`.factory/workflows/<name>.yml` from the repo, else its own copy in
`template/.factory/workflows/`. A file that does not parse stops `factory watch` at boot, and
`factory doctor` lists every problem.

## The library, and a workflow per issue type

The runner ships these. Each one stops a bad output at a different rung:

| Workflow | Steps | What stops a bad change |
|---|---|---|
| `feature-to-pr` | triage, plan, build, verify, pr | gates, then verify; a risky plan parks for approval |
| `bug-to-pr` | triage, build, verify, pr | verify rejects back to build; no plan step |
| `docs-to-pr` | triage, build, pr | the gates only (a lint or link check); red gates park it |
| `approved-plan-to-pr` | triage, plan, build, verify, pr | every plan parks for a person, whatever its risk |

`routes.<type>.workflow` runs a type on its own workflow, for example
`"routes": { "docs": { "workflow": "docs-to-pr" } }`. The type comes from the label the issue was
filed with. At pickup the runner comments which workflow it chose and records it on the thread, so a
restart or another machine resumes the same one. Only the first choice in a trusted comment counts,
so a marker someone pastes later cannot move an issue off a workflow that parks every plan. An issue whose type names none runs
`config.workflow`. Every named workflow loads at boot, so a typo stops `factory watch`.

`factory harness validate` loads every workflow file, the repo's and the runner's, and every one the
config names, and exits 4 on a problem. `factory harness inventory` lists each one's steps, cron
triggers and the types routed to it.

## Step keys

| key | meaning |
|---|---|
| `uses` | the step type: `triage`, `plan`, `build`, `verify`, `pr` or `check` |
| `label` | the `factory:*` label the issue holds during the step; unique per workflow |
| `next` | a step id, or a list of edges; `pr` ends the workflow, so it has none |
| `reject` | where a rejection goes; required on `verify` |
| `revise` | where `/factory revise` goes when the issue is parked on this step's label |
| `run` | a `check` step's shell command; exit 0 moves on, anything else parks the issue as failed |
| `runtime` | where a `check` step's command runs, by name ([runtimes.md](runtimes.md)); default `runtime.check` in config, else `local` |
| `mcp` | MCP server names from `.factory/mcp.json` this step's agent may use; not on a `check` step |

An edge is `{ to: <step> }` or `{ park: awaiting-approval, approve: <step>, revise: <step> }`,
with an optional `if:`. The first edge whose `if:` holds wins; the last has no `if:`.

`limits.questions` caps needs-info rounds and `limits.rejects` caps rejections (both default 2).

## `on:` schedules and events

A workflow can file its own issues on a schedule, on an event, or both:

```yaml
on:
  cron:
    - schedule: "0 2 * * *"      # minute hour day-of-month month day-of-week
      tz: Europe/Berlin          # IANA zone, default UTC
      title: Nightly dependency check
      body: Bump what is safe.
```

At the matching minute the watcher files an issue labelled `factory:ready`, which the workflow then
runs like any other. A poll that skipped past the minute catches up for up to an hour, and while an
issue from the same trigger is still open no new one is filed.

```yaml
on:
  event: wiki.page.updated       # one type from docs/events.md, or a list
```

Each event files one issue per event id with the event data in its body; a redelivered event files
nothing new. A factory event's issue is `factory:ready`. Another app's event files it unlabelled, for
a maintainer to read and label (see [events.md](events.md)).

## `mcp:` servers per step

`.factory/mcp.json` lists the servers, in Claude Code's own format:

```json
{ "mcpServers": { "docs": { "command": "docs-mcp", "args": ["--stdio"] } } }
```

A step that names `mcp: [docs]` runs with only `docs` loaded (`--mcp-config` with
`--strict-mcp-config`) and with its tools allowed; every other step loads none. Only the `claude`
preset can load servers, so a step naming one under another agent fails. The runner reads the
registry from its clone of the base branch, never from the issue's worktree, so an agent cannot add
a server for a later step to launch; a server entry is a command, trusted like a gate. A name missing from the
registry fails the issue before the step runs, and `factory doctor` reports it first.

## `if:`

`if:` reads a step's JSON by its id (`plan.risk`), `toggles.autoApproveLowRisk` and `config` (so `config.riskPolicy.autoApproveMaxRisk`). It
has `==`, `!=`, `&&`, `||`, `!`, parentheses, and string, number and boolean literals. A name it
cannot resolve is a load error.

## What the loader refuses

Unknown keys, an unknown step type, a duplicate label, an edge to a missing step, a `next:` loop
(only `reject`, `revise` and `approve` may point back), a step no edge reaches, and edges after
one with no `if:`.

## Example: lint before verify

```yaml
name: quick-fix
steps:
  triage: { uses: triage, label: factory:triaging, next: build }
  build: { uses: build, label: factory:building, next: lint }
  lint: { uses: check, label: factory:linting, run: make lint, next: verify }
  verify: { uses: verify, label: factory:verifying, next: pr, reject: build }
  pr: { uses: pr, label: factory:in-review, revise: build }
```

A new label such as `factory:linting` needs creating once: `factory doctor --fix`.
