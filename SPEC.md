<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E3 Reliability runner
Milestone: Phase 1 reliability
Runner: operator

## Risk: medium

## Why
A self-healing step can mark a failing test skipped, so the suite goes green with less coverage. Issue #362 (extends #335).

## Today
- Gates and the verify step live in `src/gates.ts` and `src/engine/verify-facts.ts`; grep for the existing tests-only diff check from #335 and read it first. Join the new check with it rather than adding a second place.

## Change
### T1: count skips in a diff
Files: `src/skip-count.ts`, `tests/skip-count.test.ts`
Model: sonnet
1. `src/skip-count.ts` exports `skipDelta(diff: string)`: the number of added lines that introduce `test.skip`, `it.skip`, `describe.skip`, `test.fixme`, `test.todo`, `xit(`, `xtest(` or `.skip(` minus the removed lines that held them, counting only lines in test files (`*.test.ts`, `*.spec.ts`, `tests/` paths).
2. Tests with unified-diff fixtures: an added `test.skip` gives 1; removing one gives -1; a skip in a non-test file gives 0; a changed line that keeps its skip gives 0.

### T2: fail verify on a rise
Files: `src/engine/verify-facts.ts`, `tests/verify-skip.test.ts`
Model: sonnet
Deps: T1
1. Where verify builds its facts from the agent diff, add the skip delta. A delta above 0 fails verify with a reason that names the file and says a skipped test needs a person.
2. Test: a diff that adds `test.skip` fails verify; a diff that deletes a skip passes.

## Tests
- `tests/skip-count.test.ts`: [permanent] the counting cases.
- `tests/verify-skip.test.ts`: [permanent] verify fails on a rise.

## Mutation
```json
{"name":"skip-count: ignore added skips","file":"src/skip-count.ts","find":"skip","replace":"skip_","test":"tests/skip-count.test.ts"}
```
Adjust `find` to text that occurs exactly once in the file as you wrote it.

## Acceptance
- AC-1: an added `test.skip` in a test file counts 1: checked by `make test FILES=tests/skip-count.test.ts` (T1)
- AC-2: verify fails on an agent diff that adds a skip: checked by `make test FILES=tests/verify-skip.test.ts` (T2)

## Non-goals
Do not touch .github/workflows (stage workflow edits under ci/). No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
- `src/skip-count.ts`
- `tests/skip-count.test.ts`
- `src/engine/verify-facts.ts`
- `tests/verify-skip.test.ts`

## How to ship
One PR from branch feat/s-skip-count. Commits use `git commit -s`. Fill every section of .github/pull_request_template.md with real evidence. Run `python3.12 scripts/kaas/check-affected.py --run` before pushing. Each new mutation entry is {name,file,find,replace,test}; its `find` matches exactly once and the test must fail under the replacement. Put new mutations in a shard file `tests/mutations/s-skip-count.json`, never in tests/mutations.json. Never put a session link in a commit or PR.
