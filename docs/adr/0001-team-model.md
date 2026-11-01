# 0001. Team model: teams are config files

## Status

accepted

## Context

A repo's factory behaviour (who may approve, which roles and workflows run, how much a month may
cost) is set in several places: the built-in defaults, the repo's `.factory/config.json`, and any
team or org rules. A new team needs to see which file set each value, without reading the runner.

## Decision

Team rules are YAML files in the repo, under `.factory/team/`. The org file is `org.yml`; each team
is one file in `.factory/team/teams/`. `src/team/schema.ts` names the fields:

- Org: `name`, `roles`, `workflows`, `policy`, `locked`.
- Team: `name`, `mission`, `members`, `approvers`, `repos`, `source`, `roles`, `routes`,
  `workflows`, `policy`, `budget_usd_month`, `concurrency`.
- Source: `kind`, `project`, `ready`, `statuses`, `types`. `kind` is required.
- Role: `harness`, `model`, `skills`, `tools`, `runtime`, `locked`.
- Policy: `risk_max`, `auto_merge`, `models`, `protected_paths`, `approvals`, `budget_usd_month`,
  `extend`.

A repo belongs to at most one team. `applyTeam` refuses a repo that two team files both list.
Gates are not team fields: they stay in the repo's own `.factory/config.json`.

Teams are config, not code, so a change to a team is a change to a tracked file, and
`factory explain` can print the level that set each key.

## Consequences

- A team can be added or changed without a runner release.
- Shape errors are returned as sentences by `teamProblems`; the file is not loaded past them.
- The set of fields is fixed by `schema.ts`. Adding a field means editing that file and the resolver.

## Alternatives considered

- Keep every rule in the repo's single config file. Rejected: one file cannot hold an org default
  that several repos share.
- Store rules in the tracker or a database. Rejected: a rule change would not appear in the repo's
  history or in `factory explain`.
