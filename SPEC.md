<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E3 Reliability runner
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
Four runs started from 800-byte stub specs because nothing between "spec pushed" and "run started" reads the file. Issue #364.

## Today
- `scripts/lint-planned.ts` exports `lintPlanned(body, config)` and returns a list of problems for a planned-issue body.
- A run starts in `src/engine/runner.ts`; the planned body comes from the issue or from an operator-passed spec. Read how the run first loads the body before you edit.

## Change
### T1: the guard
Files: `src/plan-guard.ts`, `tests/plan-guard.test.ts`
Model: sonnet
1. `src/plan-guard.ts` exports `guardPlan(body, config)` returning `{ok: true}` or `{ok: false, reasons: string[]}`. Reasons: body under 1500 bytes; a missing `## Why`, `## Change`, `## Tests`, `## Acceptance` or `## Files` heading; anything `lintPlanned` returns. Each reason names the missing part.
2. Tests: a header-only fixture fails with every missing heading named; an 800-byte body fails on size; a valid fixture (copy the shape of an accepted planned body) passes.

### T2: refuse at run start
Files: `src/engine/runner.ts`, `tests/plan-guard-run.test.ts`
Model: sonnet
Deps: T1
1. Where a run first has the planned body and before any agent step, call `guardPlan`. On failure, stop the run with the `needs-human` outcome and post one comment listing the reasons. Do this for the operator-passed spec path too.
2. Test with the engine test harness (see `tests/engine-harness.ts`): a stub plan ends in needs-human with no agent step executed; a valid plan runs on.

## Tests
- `tests/plan-guard.test.ts`: [permanent] the guard cases.
- `tests/plan-guard-run.test.ts`: [permanent] the run refuses before any agent step.

## Mutation
```json
{"name":"plan-guard: accept a stub plan","file":"src/plan-guard.ts","find":"1500","replace":"0","test":"tests/plan-guard.test.ts"}
```
Adjust `find` to text that occurs exactly once in the file as you wrote it.

## Acceptance
- AC-1: a header-only plan fails and names the missing parts: checked by `make test FILES=tests/plan-guard.test.ts` (T1)
- AC-2: a stub plan stops the run before any agent step: checked by `make test FILES=tests/plan-guard-run.test.ts` (T2)
- AC-3: a valid plan still runs: checked by `make test FILES=tests/plan-guard-run.test.ts` (T2)

## Non-goals
Do not touch .github/workflows (stage workflow edits under ci/). No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
- `src/plan-guard.ts`
- `tests/plan-guard.test.ts`
- `src/engine/runner.ts`
- `tests/plan-guard-run.test.ts`

## How to ship
One PR from branch feat/s-plan-guard. Commits use `git commit -s`. Fill every section of .github/pull_request_template.md with real evidence. Run `python3.12 scripts/kaas/check-affected.py --run` before pushing. Each new mutation entry is {name,file,find,replace,test}; its `find` matches exactly once and the test must fail under the replacement. Put new mutations in a shard file `tests/mutations/s-plan-guard.json`, never in tests/mutations.json. Never put a session link in a commit or PR.
