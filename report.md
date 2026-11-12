BRANCH: go/k6-approval
HEAD: d1772f05b839c70a1f04140541934fb2418c388d
## Summary
Added `PlanApproval` in `internal/tracker/github/approval.go`: approval is a trusted `/factory approve` comment posted after the latest plan comment, not yet acked, and not voided by a later revise or cancel. The rule is not yet reachable from `cmd/factory` (see API change requests).
## Acceptance
- act starts only from an approval event on a plan already posted, never the same turn or the task text -> TestPlanApproval (rows: no plan, approve before plan, approve after plan, reader, already handled, plain text, revised plan needs new approve) -> done as a tested function; wiring blocked (see below)
- a UI or API toggle racing a completed plan run does not start act -> TestPlanApproval: only comments count, so a toggle is no event; approve before the plan or voided by revise/cancel returns 0 -> done at the function level; blocked on wiring
- a rejected plan leaves no checkpoint and no edits -> blocked: checkpoints are ticket 1 (gitx) and the act start lives in observe/core, outside my area. Here a revise or cancel after approve returns 0 (rows "revise after approve voids it", "cancel after approve voids it")
Bite-check: using all comments instead of those after the plan failed "approve in the task text before the plan"; dropping the revise/cancel reset failed both "voids it" rows. Both reverted.
## API change requests
- internal/observe/commands.go: add `VerbApprove`, and have `Tracker.Commands` emit it when `PlanApproval` returns a ref (a one-line method over `t.thread` and `t.trust`; I left it out because nothing calls it). The loop must start act only on that verb. Until then `PlanApproval` is unreachable, so deadcode counts it.
## Files outside my area
none
## Gate evidence
just is not installed; ran the recipe bodies by hand: gofmt -l . (empty), go vet ./... (clean), golangci-lint v2.13.2 (GOTOOLCHAIN=go1.26.7): "0 issues.", go test -race ./...: all ok (last lines: ok .../pkg/agentrun, ok .../pkg/sandbox), CGO_ENABLED=0 go build ./cmd/factory: built. I did not run just fast or just check, so no pre-push hook ran either.
Measures: non-test Go lines (repo-wide) before 20360, after 20393 (+33; the 1319 I first counted was only the package directory). Deadcode lines: before 69 (with my files present, measured before commit); the after count equals it plus the new function unless wired.
## Learnings
- git ls-files in a subdirectory only counts that directory; run measures from the repo root.
- Tickets that touch a decision rule should name the observe verb and tracker method together, since the area boundary splits them.
