# 0006. Policy ceiling: hard-deny and soft-deny marks

## Status

accepted

## Context

A team file and a repo file can set policy values: `risk_max`, `auto_merge`, `approvals`,
`budget_usd_month`, `models`, `protected_paths`. The org sets the ceiling those values sit under. Some
org rules must never be relaxed by a team or a repo. Others may be relaxed, but only by a named
approver. The org needs a way to say which is which.

## Decision

The org file marks a rule under `policy.deny` as `hard` or `soft`. Only the five rules in `DENY_RULES`
can be marked: `risk_max`, `auto_merge.allowed`, `auto_merge.max_risk`,
`approvals.requester_cannot_approve`, `budget_usd_month`. Any other key, or a kind that is not `hard`
or `soft`, is a problem returned by `teamProblems`.

A team file lifts a soft rule under `policy.preapprove`, mapping the rule to an approver. `denyOf`
refuses a pre-approval when the rule is not marked soft, when it is marked hard, or when the approver
is not in the team's own `approvers` list. Only a valid pre-approval lifts a rule.

When the team and repo levels set a value, `Merge.policy` applies these checks:

- A hard-marked rule may only be set to the value the current config already holds. Any other value
  is refused and the org's value stays.
- A soft-marked rule set to a looser value is refused, unless the rule is lifted. A lifted rule takes
  the team's value.
- Every other rule keeps the stricter value. `risk_max` and `auto_merge.max_risk` take the lower risk,
  `auto_merge.allowed` takes `false` if either side is `false`, `budget_usd_month` takes the lower
  number, and `models` keeps only the entries both sides list.
- `protected_paths` takes the union of both lists when the org sets `policy.extend: true`. Without
  that flag it keeps the entries both lists share.

The org level itself is not checked against marks. The org sets its own values.

## Consequences

- An org can make a rule a fixed floor (`hard`) or a floor that one named person can lower (`soft`),
  and `factory config explain` can print which kind holds a marked rule.
- A refusal is a sentence in `problems`; the value is not applied, and the rest of the file still
  loads.
- A lifted soft rule takes the team's value as written, so the team's own approver is the only check
  on how far it moves.
- Under the intersection rule, a team's `protected_paths` list can drop an entry the org listed unless
  the org sets `extend: true`. The code does this as written; this record does not claim otherwise.

## Alternatives considered

- Treat every ceiling rule as fixed. Rejected: the org then has no way to let one named approver
  lower a rule for a single team.
- Treat every ceiling rule as lowerable. Rejected: the org could not say that a rule must never move.

## Where in the code

- `src/team/schema.ts`: `DENY_KINDS`, `DENY_RULES`, `denyProblems` (called from `teamProblems`).
- `src/team/resolve.ts`: `resolveTeam`, `denyOf`, `Merge.policy`, `stricter`.
- `src/team/apply.ts`: `applyTeam`, which calls `resolveTeam` with the org and team files.
- `src/team/explain.ts`: the lines that name a rule as hard-deny or soft-deny.
- `src/team/always-allow.ts`: refuses an entry the org ceiling does not allow (uses `resolveTeam`).
