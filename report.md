BRANCH: go/reconcile
HEAD: ea446a2f67262f0e94946b1ae0e651b2506c2e41
## Summary
Added `internal/pick` (Rank, Overlap, Refill) and `internal/reconcile` (pure Decide, Backoff, Tick with restart recovery, Run). All acceptance lines are met; three commits, one per group, pushed to `go/reconcile`.
## Acceptance
- Decide follows Symphony 8.1 tick order, table test per 17.4 case -> TestDecide (claim, no slot, preflight, running, stall, retry backoff, terminal, operator cancel, needs-human, reconcile-before-dispatch) -> done
- Backoff min(10s*2^(n-1), 5m), attempts 1 to 7 -> TestBackoff -> done
- Stall: one Steer, Retry at 2x, NeedsHuman after MaxAttempts -> TestDecide rows "stall steers once", "already steered stays quiet", "no push at twice stall retries", "max attempts needs human"; TestTickStallRetryNeedsHuman end to end -> done
- Pushed branch with no report counts as running -> TestDecide "pushed branch without report is running", "report without PR is running" -> done
- Refill caps (min(free, firesLeft), no overlap among picks, none overlapping running, none blocked) -> pick.TestRefill, pick.TestOverlap -> done
- Restart rebuilds the same running set from Tracker and Observer only (including a ticket on attempt 2) -> TestRestartRebuildsRunningSet -> done
- Run stops on cancel and makes no call after -> TestRunStopsOnCancel (cancel after the 1st, 2nd, 3rd and 5th port call), TestRunCancelledBeforeStartMakesNoCall -> done
## API change requests
- `Tracker.Ready` returns only phase "ready" tickets in the fake. Restart recovery (Symphony 14.3) needs the tracker to list active tickets (ready, claimed, running, retry) too. The test wraps the fake with a local `activeTracker` for that. Either define `Ready` as "not finished" or add `Active(ctx)`.
- `Observer.Observe` needs an attempt, which a restarted process does not know. Recovery probes attempts MaxAttempts down to 1 and takes the first with a branch. A `Latest(ctx, id)` method would drop the probing.
- No port reads the merge queue. `pick.Locks` (held files, unmerged tickets) is supported by Decide through `State.Locks`, but `Run` leaves it empty until someone supplies it.
## Files outside my area
none
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt -l (clean), go vet ./... (clean), golangci-lint v2.13.2 via go run (`0 issues.`), `go test -race ./...` (all packages ok, including provenance), `CGO_ENABLED=0 go build -o dist/factory ./cmd/factory` (BUILD OK).
Mutation spot checks went red: removing the 2x retry, the steer-once guard, the report-and-PR requirement for done, the MaxAttempts cap, the backoff cap, three ctx guards in Tick, and the attempt probe in recovery.
## Learnings
- `just` is missing in cloud sessions; the defaults should install it or ship a `scripts/gate.sh` that does what the recipes do.
- golangci-lint v2.13.2 needs Go 1.26 and the toolchain switch downloads a lot; a cached binary would save minutes.
- The porttest Tracker cannot express "active but not ready", which hid the restart problem until I wrote the test; the fakes should list active tickets.
- Fake-based cancellation tests are only deterministic if the fake cancels the context itself on the Nth call.
