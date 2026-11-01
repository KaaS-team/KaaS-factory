# 0002. Resolution rules for team config

## Status

accepted

## Context

An org file, a team file and a repo's own config can all set the same key. The resolver in
`src/team/resolve.ts` must give one answer per key, and the answer must be the same every time for the
same files.

## Decision

`resolveTeam` applies four rules, in the order builtin, org, team, repo:

1. Inherit. A key that no level sets keeps the builtin value.
2. Policy is a ceiling. A value under `policy` is combined with the value already set, and the
   stricter one wins: the lowest `risk_max`, `budget_usd_month`, `auto_merge.max_risk` and
   `models` list intersection; `auto_merge.allowed` and `requester_cannot_approve` take the
   stricter boolean. `protected_paths` is an intersection unless the org sets `policy.extend: true`,
   which makes it a union.
3. Roles, workflows and routes replace by name. A team's `roles.builder` replaces the org's
   `roles.builder`. A name listed in the org's `locked` is not replaced by a team or the repo; the
   resolver records a problem and keeps the org's version.
4. The config hash is stamped on every run. `configHash` covers the applied config, and the runner
   writes it into the run and stage records (`src/engine/common.ts`).

Preferences (`model`, `workflow`, `labels`, `timeouts`) are not ceilings: the most local level wins.

## Consequences

- A team cannot raise a limit the org set. `factory explain` shows `policy.risk_max = "medium" (org)`
  when a team asks for `high`.
- A stage row can be matched to the exact config it ran with.
- A preference set at the repo level overrides the team's, and the explain output names the repo.

## Alternatives considered

- Last file wins for every key. Rejected: a team file could then loosen a limit the org set.
- Merge roles by deep merge. Rejected: a partial role would silently keep fields the team did not mean
  to keep.
