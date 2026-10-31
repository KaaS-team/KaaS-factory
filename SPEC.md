<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: e3-reliability
Milestone: phase-1
Runner: factory

## Risk: low

## Why
PR #377 (branch feat/e3-watch-temp, closes #270) makes `make test` run under a per-run `TMPDIR` that is removed at the end. Its CI step "New and changed tests run three times" fails: `tests/temp-leak.test.ts` tests ("make test removes temp files a child process made outside the test's own process", "make test still fails when a test fails, and still cleans up", "bun test removes the temp dirs a test made and never cleaned") fail with `ENOENT: no such file or directory, mkdtemp '/tmp/factory-test-run.XXXX/factory-test-YYYY/temp-leak-ZZZZ'`. The per-run root or the test's own parent dir is gone when the second and third repeat of the same test starts, because the first repeat's cleanup removed it. A second symptom seen earlier was the ctrf step reporting "JUnit report not found at reports/junit.xml"; check whether the `$(CACHE)` wrapper in the Makefile `test` target still writes that file.

## Today
- Branch `feat/e3-watch-temp` holds the Makefile `test` target with a `mktemp -d` root, `TMPDIR=$$root $(CACHE) test --out reports/junit.xml -- bun test ...`, and `rm -rf "$$root"`.
- `tests/temp-leak.test.ts` spawns `make test` and `bun test` children and asserts no `factory-*` entries remain.

## Change
### T1: make the temp-leak tests safe to repeat
Files: `tests/temp-leak.test.ts`, `Makefile`
Model: sonnet
1. Run `git fetch origin feat/e3-watch-temp main && git checkout -B feat/e3-watch-temp origin/feat/e3-watch-temp`. Reproduce locally with `bun test tests/temp-leak.test.ts --rerun-each 3` (the CI step repeats each test three times).
2. Find why the second repeat sees a missing parent dir. Each test must create its own fresh temp root in `beforeEach` (or inside the test) and never depend on a dir another repeat removed. Fix the test, or the Makefile cleanup if it removes more than the root it created.
3. Run `make test FILES=tests/temp-leak.test.ts` and confirm `reports/junit.xml` exists afterwards; if the `$(CACHE)` wrapper skips writing it, fix the Makefile so the report is always written.

## Tests
- `tests/temp-leak.test.ts`: [permanent] passes with `--rerun-each 3` and in a single run.

## Mutation
none: the four mutations already on the branch must still bite.

## Acceptance
- AC-1: the temp-leak tests pass three times in a row: checked by `make test FILES=tests/temp-leak.test.ts` (T1)
- AC-2: `make test` leaves `reports/junit.xml` and no `factory-*` entries in TMPDIR: checked by `make test FILES=tests/temp-leak.test.ts` (T1)

## Non-goals
Do not touch .github/workflows. No new dependencies. No em dashes, no filler words. Nothing outside Files. Do not weaken an assertion to make it pass.

## Files
- `tests/temp-leak.test.ts`
- `Makefile`

## How to ship
Fast-forward commit on top of feat/e3-watch-temp so PR #377 updates, no force push. Commits use `git commit -s` with the trailer Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>. Run `python3.12 scripts/kaas/check-affected.py --run` before pushing (tests/lean-resources.test.ts may fail in the sandbox only). Never put a session link in a commit.
