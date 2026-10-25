# splitbill factory charter

## Risk tiers

- **low**: docs-only, test-only, or a change confined to a single
  non-protected module with no schema or API-shape change. Auto-approved
  when the dashboard's "Auto-approve low-risk plans" toggle is on.
- **medium**: touches more than one module, adds/changes an API route or
  DB column, or is a dependency minor/patch bump. Waits for
  `/factory approve`.
- **high**: a dependency major-version bump, anything that touches
  `src/auth/**`, or a plan the planner itself flags low-confidence. Waits
  for `/factory approve`; the plan comment must show the charter rule it
  triggered.

## Protected paths

A plan that requires editing any of these is **refused at triage**, never
planned or built by an agent - it needs a human PR:

- `src/auth/**`
- `.factory/**`
- `.claude/**`
- `.agents/**`
- `.github/**`

**Exception:** lockfile changes (`bun.lock`) are allowed when the issue's
type is `dependency` - that's the one edit a dependency-upgrade PR is
expected to make outside `src/`.

## STOP_IF

If **3 factory PRs are already open** (`In review` column), the watcher
pauses picking up new `factory:ready` issues and posts a notice on the
dashboard. Existing runs keep going; nothing new starts until a human
merges or closes one.

## Why these rules

`src/auth/**` holds token lookup and the delete-expense permission check
(see issue #5) - a boundary bug there is the kind of change that needs a
human, not an agent grading its own homework. `.factory/**`, `.claude/**`,
`.agents/**` and `.github/**` are the factory's own control surface: an
agent editing its own charter, skills or gate definitions can quietly
lower the bar it's graded against.
