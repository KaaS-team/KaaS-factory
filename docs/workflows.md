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
| `planned-to-pr` | triage, import-plan, build, verify, pr | an issue whose body is a planned issue (`<!-- factory:planned v1 -->`) brings its own plan, checked but never replanned |
| `dependency-update` | triage, build, verify, pr | verify rejects a bump the tests do not cover; files itself weekly |
| `security-audit` | triage, plan, build, verify, pr | every plan parks for a person; files itself daily |
| `flaky-tests` | triage, build, verify, pr | verify rejects a fix that is not stable; files itself weekly |
| `pr-review` | triage, review (plan), report | no PR: findings go on the issue, filed per `factory.pr.opened` event |
| `test-authoring` | triage, plan, build, verify, pr | the unit gate on build; verify rejects a test that covers nothing |
| `coverage-gap` | triage, build, verify, pr | the unit gate; files itself weekly |
| `ci-fix` | triage, build, verify, pr | lint and unit gates on build, then verify |
| `ci-cd-authoring` | triage, plan, build, verify, pr | every plan parks for a person; the lint gate |
| `release-notes` | triage, build, pr | a person merges the notes; files itself weekly |
| `harness-learn` | triage, plan, build, pr | every plan parks for a person; files itself weekly |
| `ui-component` | triage, plan, build, verify, pr | a medium or high risk plan parks; lint and unit gates |
| `spec-to-plan` | triage, plan, report | no PR: the plan comment is the output |
| `backlog-triage` | triage, report | no PR: findings as comments; files itself daily |

The rows from `pr-review` down are `.md` files. A `report` step closes the issue with no PR, and
`gates:` holds a stage to the named gates. `dependency-update`, `security-audit`, `flaky-tests`,
`coverage-gap`, `release-notes`, `harness-learn` and `backlog-triage` carry their own `on: cron:` schedule. A schedule fires only for `config.workflow` and
the workflows a route names, so route a type to one to turn it on. The issue it files records that
workflow, so pickup runs it and not `config.workflow`. Each one's body tells triage to refuse when
there is nothing to do: the issue parks as `factory:needs-human` with no PR, and the schedule files no
new one until a maintainer closes it.

`routes.<type>.workflow` runs a type on its own workflow, for example
`"routes": { "docs": { "workflow": "docs-to-pr" } }`. The type comes from the label the issue was
filed with. At pickup the runner comments which workflow it chose and records it on the thread, so a
restart or another machine resumes the same one. Only the first choice in a trusted comment counts,
so a marker someone pastes later cannot move an issue off a workflow that parks every plan. An issue whose type names none runs
`config.workflow`. Every named workflow loads at boot, so a typo stops `factory watch`.

`factory harness validate` loads every workflow file, the repo's and the runner's, and every one the
config names, and exits 4 on a problem. `factory harness inventory` lists each one's steps, cron
triggers and the types routed to it. `factory harness scaffold <name>` writes a starting
`.factory/workflows/<name>.md` (the five stages, a risky plan parks, build held to lint and unit
gates) and never overwrites one the repo has. `factory harness eval [--since <days>]` scores each
workflow from the event log: runs, outcomes, shipped rate, the steps that failed and the cost of its
issues (default the last 30 days).

`factory teach "<how we ship>"` runs one agent in a fresh clone. It reads the code, the CI in
`.github/workflows/` and, when `.factory/mcp.json` names a `brain` server, the company brain. Its
answer is a set of workflows, minions and skills. Each file is checked with the parser the watcher
uses, and the set opens as one PR on a `factory/teach-*` branch. A file outside
`.factory/workflows/`, `.factory/minions/` or `.claude/skills/`, or one that does not load, opens
no PR.

A repo needs no `.claude/` config to run. Before each stage the runner puts every factory skill and
subagent the repo lacks where the agent reads skills, taken from the runner's `template/`, and lists
them in the worktree's git exclude so no PR carries them. A skill or subagent the repo has under
`.claude/` or `.agents/` wins over the default.

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

### Human in the loop or on the loop

A park edge waits for a person: `/factory approve` goes on, `/factory revise` sends it back. Add
`after: 4h` (`30m`, `4h`, `2d`) and the person is on the loop instead. The park comment says when
the issue goes on, and if no maintainer comments within that window of the plan, the factory approves
it and says so on the thread. Any trusted comment, even "wait", holds it for a person; an outsider's
comment does not. Every park edge of one step takes the same `after:`.

```yaml
      - park: awaiting-approval
        approve: build
        revise: plan
        after: 4h
```

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

`if:` reads a step's JSON by its id (`plan.risk`), `toggles.autoApproveLowRisk`, the plan step's tier toggles `toggles.tiered` and `toggles.tierApproves` (src/autonomy.ts), and `config` (so `config.riskPolicy.autoApproveMaxRisk`). It
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
