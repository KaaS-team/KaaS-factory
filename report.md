BRANCH: cluster/v6.4-test-summary
## Summary
The failing-test summary now says a non-zero exit with a clean report is not clean, and names unhandled errors between tests with their file. The one-in-three flaky case already held on the base.
## Issues
- #649: done (one case already held).
  - Non-zero exit with no failing case names the exit code, never "no failing tests" -> "a non-zero exit with a clean report never says no failing tests and names the exit code", "the CLI takes --exit and prints the exit code" -> tests/mutations/a-failed-run-with-a-clean-report-says-no-failing-tests.json
  - Unhandled error between tests named with its file -> "an unhandled error between tests is named with its file (real bun run)" (real bun run, clean junit, exit 1) -> tests/mutations/an-unhandled-error-between-tests-is-not-named-in-the-summary.json
  - Fails on one pass of three -> already held (parseJunit keeps one row per rerun on bun 1.4.4). Pinned by "a test that fails on one pass of three is reported as failing (real bun run)" using a real --rerun-each 3 junit -> tests/mutations/a-test-that-fails-on-one-pass-of-three-reads-as-passing.json
  - Fixture test and mutation per case -> the three above.
## Staged workflow changes
none. ci.yml step 77 does not pass --exit; the unhandled-error case works there through --log.
## Checkpoints
#649: 1 to 7 all yes. Pin changed: tests/mutations/make-test-skips-the-failing-test-summary.json find text now includes --exit $$c.
## Files outside my area
Makefile (test recipe passes --exit $$c; in area as allowed). tests/mutations/make-test-skips-the-failing-test-summary.json (existing pin of that recipe text).
## Gate evidence
make fast: ok
## Risk and rollback
Low. Revert the commit. The CLI arg --exit is optional.
## Learnings
- Mutation "find" text must be checked after biome reformats the source line.
- bun 1.4.4 junit with a between-tests error writes no case for it; only the log shows it.
