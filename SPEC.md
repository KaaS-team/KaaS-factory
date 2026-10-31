<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E3 Reliability runner
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
PR #395 (branch feat/e3-verdict) fails CI at the step `make check` on its head commit 619d2eb after main was merged into it. The CI log is cut off mid-line (`dmake: *** [Makefile:43: test] Error 1`), so the failing test is not named in it. The branch added src/engine/verdict-rules.ts and edited steps.ts, proof.ts, run-summary.ts, artifacts.ts, schemas.ts, rehydrate.ts, tests/scenarios.test.ts and tests/workflow.test.ts. The merge of main touched src/artifacts.ts (FINDING_KEYS now has "evidence" and PRIOR_KEYS also exists) and tests/mutations.json. The failure is most likely an interaction between those two sets of changes, for example a test or schema that does not know both the `evidence` and the `prior` keys.

## Today
- The branch builds and its own tests were green before main was merged in (gate 2963 pass, 14 skip, 1 fail that is the tests/lean-resources.test.ts sandbox flake).
- On CI the run for 619d2eb ends red with no failing test named.

## Change
### T1: find the red test and fix the interaction
Files: `src/artifacts.ts`, `src/engine/verdict-rules.ts`, `src/schemas.ts`, `tests/verdict-rules.test.ts`, `tests/scenarios.test.ts`, `tests/workflow.test.ts`, `tests/mutations.json`
Model: sonnet
1. `git fetch origin feat/e3-verdict main && git checkout -B feat/e3-verdict origin/feat/e3-verdict`.
2. Run `bun test tests/verdict-rules.test.ts tests/scenarios.test.ts tests/workflow.test.ts tests/rehydrate.test.ts tests/artifacts.test.ts 2>&1 | grep -E "\(fail\)|[0-9]+ fail"` and then `python3.12 scripts/kaas/check-affected.py --run > /tmp/gate.log 2>&1; grep -E "\(fail\)|[0-9]+ fail|survived|matches" /tmp/gate.log`. Name every failing test in the final message. The lean-resources test may fail in the sandbox only.
3. Fix the cause in the smallest way: the code and the tests must agree on both `evidence` in findings and `prior` at the top level. Do not delete or loosen a test; if a test must change, state the reason in the commit message with a line `Test change reason: <why>`.
4. If `make check-mutations` reports an entry that matches 0 times or does not turn a test red, fix the entry, not the file it targets.

## Tests
- The tests named in step 2: [permanent] green on the branch.

## Mutation
none: the 8 entries already on the branch must still each turn a test red.

## Acceptance
- AC-1: no test is red apart from the sandbox flake: checked by `make test FILES=tests/verdict-rules.test.ts` (T1)
- AC-2: the gate is green with counts reported: checked by `make test FILES=tests/scenarios.test.ts` (T1)

## Non-goals
Do not touch .github/workflows. No new dependencies. No em dashes, no filler words. Nothing outside Files; if the fix needs another file, list it in the final message and make the change.

## Files
- `src/artifacts.ts`
- `src/engine/verdict-rules.ts`
- `src/schemas.ts`
- `tests/verdict-rules.test.ts`
- `tests/scenarios.test.ts`
- `tests/workflow.test.ts`
- `tests/mutations.json`

## How to ship
Commit with `git commit -s` on top of feat/e3-verdict (fast-forward, no force push) and `git push origin feat/e3-verdict` so PR #395 updates. Never put a session link in a commit or PR.
