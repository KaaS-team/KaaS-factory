BRANCH: cluster/v8.0-stack-wiring
HEAD: fa80776439addfe44d96e48aa67fe6900ae63c3b
## Summary
Wired the shipped planStack/openStack/retargetAfterMerge/carryUp into build and the pr step behind a new `delivery.stack` key ("epic" default, "task" opts in). Open, merge-and-retarget, carry-up and mid-stack conflict are proven through the pr step's code path with real git.
## Issues
- #645: done.
  - One PR per slice, each based on the one before -> `pr step with delivery.stack > task mode opens one draft PR per slice, each based on the one before` (engine run through advanceIssue) -> tests/mutations/stack-pr-pr-step-ignores-the-slices.json, stack-pr-every-slice-gets-the-closing-body.json, stack-pr-build-cuts-slices-on-any-commit-count.json. Default off -> `delivery.stack config > defaults to epic...` and `epic mode... opens the one PR` -> stack-pr-delivery-stack-defaults-to-task.json.
  - Lower slice merges, next rebased onto base and retargeted -> `a lower slice merges > the next slice is rebased onto main and its PR base moves to main` -> stack-pr-a-merged-lower-slice-is-not-rebased.json.
  - Lower-slice change carried up, or parks naming the conflict -> `a change on a lower slice > is pushed and carried up...` -> stack-pr-a-fix-on-a-lower-slice-is-not-carried-up.json; `...parks naming the conflict when a slice above cannot take it` and `a lower slice merges > a conflict in the middle of the stack parks naming the slice and the file` -> stack-pr-a-conflicting-retarget-does-not-park.json.
  - Tests cover open, merge-and-retarget, mid-stack conflict -> all of the above in tests/stack-pr.test.ts. All seven mutations reported caught.
  - Limits: the merge and carry-up paths run when the pr step is re-entered (deliverStack), and the tests call deliverStack directly for them; open is driven through advanceIssue. Carry-up covers a fix committed on a slice branch in the worktree; a rebuild that adds commits so the count no longer matches the tasks leaves the run as one PR. Tasks reach plan.json only from an imported plan (the planner schema refuses them), so stacking applies to those plans.
## Staged workflow changes
none
## Checkpoints
1 yes (src/engine/stack-pr.ts new; steps.ts, config.ts, config-merge.ts, stacked-prs.ts one-word export; the brief's "src/stack" is src/stacked-prs.ts, src/stack.ts is unrelated init detection). 2 yes. 3 yes. 4 yes: each mutation bites. 5 NO, deliberate: line-cap baselines raised, see below. 6 yes: full make test, 4298 pass 0 fail. 7 yes.
## Files outside my area
- src/config-merge.ts: DeliveryConfig and validation, kept out of config.ts like the merge keys.
- quality-baseline/lines/src__config.ts.json 796 -> 803 and src__engine__steps.ts.json 540 -> 544: the config key and the hooks cannot fit under the caps; regenerated with --allow-raise. Most of the pr logic sits in the new file to keep steps.ts at +4.
## Gate evidence
make fast: ok
## Risk and rollback
Low: off by default; "task" only changes runs whose plan has two or more tasks. Roll back by reverting the commit or leaving delivery.stack unset.
## Learnings
- tests/engine-harness.ts plan outputs cannot carry tasks (schema refuses); put plan.json with tasks in the build stage's outputs.
- Tests that rebase need git user.name/email set in the repo; plain bun test passed with a global identity but make test failed.
- FakeGitHub has no retargetPr; add it in a subclass, do not use override.
- Moving code between files breaks mutation finds; run make fast after any move.
