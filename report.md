BRANCH: go/core
HEAD: 76a6be9bb8bfb60239b68bbc0b5ff8610ea95a4d
## Summary
`internal/core` implements `api.Control` over one reconcile loop. It wraps the ports so every decision publishes an `api.Event`, and fans events out without ever blocking the loop.
## Acceptance
- Compile-time assertion `var _ api.Control = (*Core)(nil)` -> core.go and core_test.go -> done
- Three ready, two slots, third after one merges, events in order -> TestTwoSlotsThreeTicketsThirdAfterMerge -> done (events: dispatched a, dispatched b, queued a, gate, merged a, dispatched c; the slot frees at the end of the pass that merged, so c starts on the next tick)
- Manual Dispatch, Steer, Cancel, Retry reach the dispatcher once and emit one event; Retry raises the attempt -> TestManualControl (4 rows), TestManualControlErrors, TestRetryAfterNeedsHuman -> done
- Slow subscriber dropped after a bounded buffer, loop keeps ticking, with -race -> TestSlowSubscriberDroppedLoopKeepsTicking -> done
- Restart over an api.Lister tracker shows the running ticket without dispatching it -> TestRestartShowsRunningTicketWithoutDispatch, TestRestartFromReadyWithoutLister -> done
Also covered: budget steer then stop (Symphony 13.5, TestBudgetSteersThenStops), stall event (TestStallEmitsStalled), dep validation (TestNewValidatesDeps).
## API change requests
- `reconcile.Tick` treats any ticket missing from `Tracker.Ready` as terminal and cancels it, so a tracker's `Ready` must list claimed and running tickets too. `porttest.Tracker.Ready` returns only phase ready, which breaks the loop. Core works around it by merging `Lister.Active` into `Ready`; a clearer contract is either a doc line on `api.Tracker.Ready` or an in-progress variant in porttest.
- `mergeq.Runner` has no enqueue. Core defines `core.MergeQueue` (Enqueue, Queued, Run); someone must adapt `mergeq.Runner` and the tracker's queue store to it.
## Files outside my area
none
## Gate evidence
`just` is not installed here, so I ran the recipe bodies by hand: gofmt -l (clean), go vet ./... (clean), golangci-lint v2.13.2 on go1.26.7 ("0 issues."), go test -race ./... (all ok, last line `ok github.com/KaaS-team/factory/internal/tracker/vendorkit`), `CGO_ENABLED=0 go build ./cmd/factory` (ok).
## Learnings
- `just` missing from the cloud image; the factory default should install it or the brief should give the by-hand chain (it did).
- reconcile's "not in Ready means terminal" rule is undocumented in api.go and cost a debug round.
- The first test run of the three-ticket case failed on slot timing: reconcile frees a slot in the same tick it marks done, so dispatch of the next ticket lands one tick after the merge.
