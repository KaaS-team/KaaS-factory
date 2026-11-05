BRANCH: cluster/v7.1-retro-tiers
HEAD: 5da5eddc1f80c09506b11bed85feb83e55539c5a
## Summary
Every finished run now gets a retro row (failed, cancelled and PR-less shipped runs were missing one), with a coverage function held at 100 percent by a test. Plans tag tests scaffold or permanent, the retro proposes the prune, and a suite ratchet wired into make check caps test count, leftover scaffold titles and run time.
## Issues
- #221: done.
  - Every finished run gets a retro, coverage held at 100 percent -> tests/retro-coverage.test.ts "a run the triage agent reports failed is covered, and the queued retro runs", "a parked run whose issue was closed outside the factory is cancelled with a retro", "a plan-rubric lesson does not stand in for a run's retro", "a shipped run waiting on its PR is not yet finished" -> tests/mutations/finish-queues-no-retro-for-a-finished-run.json
  - Each plan test tagged scaffold or permanent -> tests/schemas.test.ts "a plan tags each test it adds" (4 tests) -> a-test-proof-plan-with-no-tagged-test-is-accepted.json, a-test-listed-as-scaffold-and-permanent-is-accepted.json
  - Count and runtime ratchet -> tests/suite-ratchet.test.ts (9 tests, incl. "make check runs it after the tests") -> the-ratchet-lets-the-suite-grow-past-its-ceiling.json, the-ratchet-ignores-a-leftover-scaffold-test.json, the-ratchet-ignores-a-slow-suite.json, the-ratchet-accepts-a-ceiling-with-no-growth-reason.json
  - Retro proposes the prune -> tests/retro-prune.test.ts "a finished run whose plan tagged scaffold tests gets a prune lesson naming each one", "a plan with no scaffold tests proposes no prune" -> the-retro-proposes-no-prune-for-scaffold-tests.json
  - Scaffold tests "graduate or are pruned": enforced by the ratchet (a test titled with the scaffold tag fails make check; ceiling 0) and proposed by the retro. The build skill was not edited to say how to title a scaffold test; not done.
## Staged workflow changes
none
## Checkpoints
#221: 1 yes (outside files named below), 2 yes, 3 yes, 4 yes (coverage, schema, prune and ratchet mutations all bite; coverage test seen red with the fix removed), 5 yes (no cap raised; common.ts shrunk to 647 so its line baseline was lowered 649 -> 647), 6 yes (retro, proof, import-plan, plan-critic, token-budget, skills, quality tests run), 7 yes.
## Files outside my area
- src/schemas.ts, src/artifacts.ts: the plan fields and the tag check.
- src/engine/retro-finish.ts (new), src/engine/import-plan.ts: issue-planned tests are now listed as permanentTests so the new plan check accepts them.
- template/.claude/skills/factory-plan/SKILL.md: documents the fields; trimmed other lines to stay under the plan byte cap and 90-line cap.
- tests/proof.test.ts: its plan fixture lists a test.
- make/ratchet.mk (new), scripts/suite-ratchet.ts, tests/suite-ratchet.json, quality-baseline/lines/src__engine__common.ts.json.
## Gate evidence
make fast: ok
Full make test: only tests/lean-resources.test.ts failed (memory under load); it passes alone.
## Risk and rollback
Risk: a plan with proof "test" and no test list now fails its schema check; the suite ceilings (2971 tests under tests/, 120s) will conflict with any parallel branch that adds tests. A shipped run with a PR whose PR is closed unmerged still gets no retro (no handler exists for it). Rollback: revert the single commit.
## Learnings
- Running `bun x biome check --write` on a directory rewrites unrelated files; pass only your own files.
- make fast's check-tests-only rejects toBeUndefined and any test.skip text, even inside a string.
- Biome's useTemplate check fails on files I did not touch, so a directory-wide biome run is noisy.
- common.ts is at its line cap; new retro code belongs in src/engine/retro-finish.ts. The factory should say which files are capped in the brief.
- The suite-ratchet test ceiling will merge-conflict across parallel branches; the supervisor should bump tests/suite-ratchet.json once after merging all clusters.
