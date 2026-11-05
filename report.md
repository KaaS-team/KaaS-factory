BRANCH: cluster/v7.1-qa-spec
HEAD: 1da8fa34bbf6f9e4350a0a462fc8de7ced4a9486
## Summary
#360 is done: a failing screenshot now has its diff image and report.html pushed to the factory/assets branch, and the QA comment links both. #335 already held on the base branch, so no code changed for it.
## Issues
- #335: already held.
  - QA output is a committed spec -> `tests/visual.test.ts` "UI facts" test (the merge gate refuses "a UI change has no committed Playwright spec") -> mutation "qa: a UI change needs a committed spec" in `tests/mutations.json`, bites.
  - The healer cannot mark a test skipped -> `tests/healer.test.ts` "a locator-only change has no problems; each other change names its problem" -> mutation "healer: a heal never skips a test" in `tests/mutations.json`, bites.
  - The brief's draft says a spec should fail on the parent commit and pass on head. The code does not check that; the acceptance lines only ask for a committed spec, so I left it out.
- #360: done.
  - A sub-pixel change below the threshold passes -> already held: `tests/visual-compare.test.ts` "a sub-pixel change below the channel tolerance passes with nothing changed" and "a sub-pixel change passes and a moved button fails with a diff image". Mutation n/a (existing tolerance code, no change).
  - A moved button fails and the PR comment links the diff image and the HTML report -> `tests/visual-compare.test.ts` "a moved button fails and the comment links the diff image and report.html" (fails with `src/qa-step.ts` reverted, passes with it), plus "a shot within tolerance publishes and links nothing" -> `tests/mutations/the-qa-comment-drops-the-published-visual-report-links.json`, bites.
  - Existing mutation `the-qa-step-drops-the-visual-comparison-report.json` pinned the old line, so I updated its `find` text.
  - Limit: the links are raw.githubusercontent URLs, so a browser shows report.html as plain text, not rendered. The diff images render. The comment embeds each diff image inline.
## Staged workflow changes
none
## Checkpoints
- #335: no change, so checkpoints 1 to 7 are yes.
- #360: checkpoints 1 to 7 are all yes. I saw the new test fail with the fix removed and pass with it. Neighbour tests (`qa-step`, `healer`, `visual`) pass. No pins or caps moved.
## Files outside my area
none. `src/visual-publish.ts` is new and holds the push code, so `src/assets-branch.ts` is untouched; it imports `ASSETS_BRANCH` and `RunGit` from there.
## Gate evidence
make fast: ok
## Risk and rollback
Low. The publish runs only when a shot fails, and a push error is swallowed, so the QA comment then has no links and the route verdict is unchanged. Roll back by reverting the commit.
## Learnings
- `make fast` runs every mutation that touches a changed file, and an existing mutation pinned the line I rewrote. Check `grep -l "<function name>" tests/mutations/` before editing a line in `src/qa-step.ts`.
- `bun test` in this sandbox is Bun 1.4.4, not the 1.3 the brief mentions.
- `tests/lean-resources.test.ts` failed once in the full `make test` run and passed when rerun alone.
- Test deps overrides need `as never` when the injected key (`assetsGit`) is not on `WatchDeps`, or `tsc` fails.
