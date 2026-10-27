# KaaS-team/KaaS-factory factory charter

## Stack

`factory init` read this repo as **bun**, toolchain `bun`.
- gate `check`: `make check`

## Risk tiers

- **low**: docs, tests and one module outside `src/engine`, `src/machine.ts` and `src/watch.ts`.
- **medium**: anything under `src/engine`, `src/derive.ts`, `src/watch.ts` or the schemas.
- **high**: auth, the Dockerfile, release workflows and anything that changes a published contract; cite the rule.

## Protected paths

A plan that requires editing any of these is refused at triage and needs a
human PR. Keep this list identical to `protectedPaths` in `config.json`.

- `.factory/**`
- `.claude/**`
- `.agents/**`
- `.github/**`

## STOP_IF

When `maxOpenFactoryPrs` factory PRs are already open, no new
`factory:ready` issue is picked up. Existing runs, approvals, answers and
revises keep going.
