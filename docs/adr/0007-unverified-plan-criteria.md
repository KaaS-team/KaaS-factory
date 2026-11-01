# 0007. A plan criterion the verdict omits is unverified

## Status

accepted

## Context

A verify step writes a verdict that can list each acceptance criterion with a status. The plan lists
the criteria as `AC-n` ids. A verdict could say `pass` while leaving some plan criteria out of its
list. The schema check only sees criteria the verdict lists, so a verdict that drops one would still
pass.

## Decision

Each plan criterion the verdict does not mark `pass` is treated as open. `applyPlanCriteria` in
`src/engine/verdict-rules.ts` runs only when the verdict's result is `pass` and the plan names
criteria. For each open criterion:

- A criterion the verdict never names is added to `criteria` with status `unverified` and the gap
  "the verdict does not mark it met".
- A criterion the verdict names with a status other than `pass` keeps that status.
- The result becomes `uncertain`, and one `could` finding is added with the runner as its source,
  "Plan criteria not marked met: AC-n, ...".

`settleVerdict` calls it after `applyVerdictRules` and `applyPriorFindings`. Its input is the run's
`plan.json`.

A second check sits in `validateVerdict` in `src/artifacts.ts`. It refuses a `pass` result that
lists any criterion whose status is not `pass`, and any status outside `pass`, `fail` and
`unverified`.

## Consequences

- A verdict cannot reach `pass` while a planned criterion is missing or unmarked. The run ends as
  `uncertain`, which a person reads.
- The plan is the source of the criteria list. The verdict cannot shrink it.
- The criterion ids come from the plan, so a plan with no criteria skips this check entirely.
- `applyPlanCriteria` changes the result to `uncertain` but does not reject the run.

## Alternatives considered

- Trust the criteria the verdict lists. Rejected: a verdict that drops a criterion would still pass.
- Reject the run when a criterion is unmarked. Rejected: a person can read an `uncertain` run, and
  the gap is recorded as a finding.

## Where in the code

- `src/engine/verdict-rules.ts`: `applyPlanCriteria`, `settleVerdict`, `applyVerdictRules`.
- `src/artifacts.ts`: `validateVerdict` (the `pass` check and the status check).
- `src/engine/steps.ts`: calls `validateVerdict` on the verify step's `verdict.json`.
- `src/schemas.ts`: the plan's `criteria` field (array of objects).
