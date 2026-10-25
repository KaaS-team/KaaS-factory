# TODO: <repo> factory charter

Delete every TODO line. `factory doctor` fails while any remain.

## Risk tiers

- **low**: TODO what may be auto-approved (docs-only, test-only, one module).
- **medium**: TODO what always needs `/factory approve`.
- **high**: TODO what needs approval and a cited charter rule.

## Protected paths

A plan that requires editing any of these is refused at triage and needs a
human PR. Keep this list identical to `protectedPaths` in `config.json`.

- `.factory/**`
- `.claude/**`
- `.agents/**`
- `.github/**`
- TODO paths whose bugs an agent must not grade itself on (auth, billing, migrations)

## STOP_IF

When `maxOpenFactoryPrs` factory PRs are already open, no new
`factory:ready` issue is picked up. Existing runs, approvals, answers and
revises keep going.
