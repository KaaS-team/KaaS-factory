BRANCH: cluster/v8.0-subissues-shadow
HEAD: 5528419252a9156a6c17b88987dec7bac7b55cdb
## Summary
linkSubIssue now exists on the GitHub, Linear, Asana, ClickUp, Plane and Jira adapters, and the HTTP tracker refuses by name; dispatch orders through the same rank as a tick; shadow mode builds in a throwaway worktree, runs verify on that diff and pushes nothing.
## Issues
- #610: done.
  - spec step: already held on base (tests/planning-steps.test.ts "a goal's drafts become issues in Problem, Acceptance and Out of scope form"). No code change.
  - decompose links sub-issues: tests "GitHub.linkSubIssue looks up the child's database id, then POSTs it..." (tests/github.test.ts), "Linear/Asana/ClickUp/Plane/Jira specifics > linkSubIssue ..." (tests/trackers-*.test.ts), "sub-issue support per adapter > the HTTP tracker has no sub-issue concept, so decompose refuses by name before filing". Mutations: tests/mutations/{github,linear,asana,clickup,plane,jira}-linksubissue-*.json, plus the existing decompose mutations.
  - prioritize and pickup follows rank: tests "dispatch order follows the prioritize rank (#610)" x3 (rank, no method, CI bump still first) -> tests/mutations/dispatch-ignores-the-configured-prioritize-method.json. The prioritize step test already held.
  - fake-tracker tests per step: held (tests/planning-steps.test.ts).
- #611: done.
  - onboard detects, writes starter config, lists missing: already held (tests/onboard.test.ts "a bare repo gets a starter config, and the scan names what is still missing"). No code change.
  - shadow plans and verifies, comments, no branch or PR: tests "a ready issue is planned, built and verified in a throwaway worktree..." and "a reject verdict is posted and ends the run..." -> mutations shadow-mode-stops-after-plan-and-never-verifies, shadow-mode-keeps-its-worktree-after-the-run.
  - no branch created: test "a whole shadow run on a real clone leaves no branch locally or on the origin" (this one passes without the change too, since the fake agent makes no diff to push); push refusal bites through "...with no claim, push or PR" -> shadow-mode-lets-the-build-push-its-branch.
## Staged workflow changes
none
## Checkpoints
Both issues: 1 area yes (see outside-area list), 2 scope yes, 3 meaning yes, 4 proof yes (tests seen red with src stashed, green with it), 5 pins: src/github.ts line cap raised 505 -> 506 (quality-baseline/lines/src__github.ts.json) for the one delegating line, the logic lives in src/github-rest.ts, 6 neighbours yes (full make test: 4302 pass, 0 fail, no unhandled errors), 7 yes.
## Files outside my area
- src/scm.ts: ComposedScm forwards linkSubIssue, else decompose is unavailable behind it.
- src/github-rest.ts: holds the REST link logic to keep github.ts near its cap.
- src/help.ts and docs/cli-reference.md: the --shadow description said "triage and plan"; now accurate.
- tests/fixtures/trackers/*-server.ts: record a parent so the adapter tests can assert it.
## Gate evidence
make fast cannot pass here: biome ci fails on untouched base files (src/event-chain.ts, tests/healer.test.ts, tests/secret-scan.test.ts and others, plus existing lines in tests/planning-steps.test.ts). Run step by step instead: tsc clean; check-tests-only: ok; check-mutations: all 83 mutations bite; baseline --check clean; check-mutation-anchors: ok (988 entries). Full make test: 4302 pass, 0 fail.
## Risk and rollback
Shadow now runs the agent's build; any gate or agent cost applies per shadow issue. Pushes are blocked by a proxy over deps.git (push, pushBranch). Roll back by reverting the two #610 commits and the #611 commit; no data migration.
## Learnings
- make fast fails on base: `bun x biome ci .` reports useTemplate errors in files nobody touched. Fast should gate on changed files only.
- FakeGitHub extends GitHub, so adding a real method to GitHub silently changes tests that rely on "tracker lacks X"; set the property to undefined explicitly.
- src/github.ts is at its line cap; put new GitHub logic in src/github-rest.ts.
- --check of gen-quality-baseline needs --allow-raise to move a cap.
