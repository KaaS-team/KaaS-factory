BRANCH: cluster/v7.1-misses-wire
HEAD: a15ce9a7504019027602116b106a35cd0ce66990
## Summary
#328 is met by scripts/selector-misses.ts, already wired in the staged ci/mutations.yml. I added the missing row and rate tests and removed the unwired scripts/affected-misses.py.
## Issues
- #328: done.
  - Post-merge job runs the full run on main and records skipped failures -> already held: ci/mutations.yml (push to main runs all mutations, then selector-misses.ts) -> existing test "a failure reached only through an import is a miss until its inputs line is added" -> mutation: selector misses: an unselected failure is a miss.
  - A miss opens an issue naming the check and files -> existing test "the issue names the entry and holds the inputs line" -> mutation: n/a (existing, not re-proved).
  - Miss rate over the last runs -> new test "the miss rate is misses over failures across rows" -> tests/mutations/selector-miss-rate-ignores-the-misses.json (bites).
  - Skipped failing check produces a miss row -> new test "a skipped mutation that fails produces a miss row naming it" -> tests/mutations/selector-miss-row-drops-the-misses.json (bites).
  - Decision: affected-misses.py removed. It drives check-affected.py, but .agents/repo.json has no impact map and nothing calls it. selector-misses.ts covers the acceptance, so no impact map diff is needed. Its test and 3 mutation files were removed with it.
## Staged workflow changes
None new. ci/mutations.yml already carries the selector-miss steps; the supervisor must still move it over .github/workflows/mutations.yml (the live copy lacks the push-to-main miss steps and issues: write).
## Checkpoints
Issue #328: 1 to 7 all yes. Note on 6/PR body: make fast's check-tests-only fails on the deleted tests/affected-misses.test.ts and wants a "Test change reason:" line in the PR body. Suggested: "Test change reason: affected-misses.py was removed (unwired, no impact map); selector-misses.ts and its tests cover the acceptance."
## Files outside my area
None (scripts/selector-misses.ts, tests/selector-misses.test.ts, tests/mutations/*, and the deleted script and test).
## Gate evidence
make fast: only failure is check-tests-only "- state why in a \"Test change reason:\" line in the PR body" (needs the PR body). make test: 4250 pass, 0 fail; selector-misses tests pass with --rerun-each 3.
## Risk and rollback
Low. Revert the two commits to restore affected-misses.py. selector-misses.ts behaviour is unchanged (refactor to missRow and missRate).
## Learnings
- make fast cannot pass on a branch that deletes a test until the PR body has a Test change reason line; a deletion brief should say so.
- Brief's "wire affected-misses" option was not viable: no impact map exists in .agents/repo.json.
- tests with module-level mkdtemp need mkdirSync(tmpdir()) first (hit it on --rerun-each 3).
