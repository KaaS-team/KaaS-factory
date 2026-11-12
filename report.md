BRANCH: go/reconcile-hardening
HEAD: 47b946af13880997ffac707e9f0dbda5a7836816
## Summary
Reconcile now keeps workers running when an observation fails, still runs stall and terminal checks when the tracker read fails, takes a configurable retry cap, stores the retry error, and accepts initial locks. Conformance rows now point at tests for each. All six fixes went in one commit instead of one commit per acceptance group.
## Acceptance
- A table row per finding, each shown failing before the fix -> TestTickObserverFailureSkipsStall, TestTickReadyFailureStillReconciles, TestMaxRetryBackoff, TestRetryEntryError, TestDispatchFailureStoresError, TestInitialLocksReachFirstDecide, plus TestDecide rows -> done. I wrote them against field stubs and saw them fail on behaviour first. After the fix I reverted the observer skip, the Ready-failure skip and the initial locks once each, and each test went red. I did not break the stored-error or slot-exhaustion code.
- Conformance rows move to a test, mapping test passes -> Test17_4_ConfiguredBackoffCap, Test17_4_ObserverFailureKeepsWorker, Test17_4_TrackerFailureStillReconciles, Test17_4_InitialLocksHoldFiles, updated RetryEntryFields and SlotExhaustion -> done
- MaxRetryBackoff of 1m caps attempt 8 at 1m -> TestMaxRetryBackoff, Test17_4_ConfiguredBackoffCap -> done
- Finding 6, the comment on the Ready list in Tick -> done (a comment in `internal/reconcile/run.go`).
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: `test -z "$(gofmt -l .)"`, `go vet ./...`, golangci-lint v2.13.2 ("0 issues."), `go test -race ./...` (every package ok, last line `ok  github.com/KaaS-team/factory/packs`), and `CGO_ENABLED=0 go build ./cmd/factory` (the binary was deleted).
## Notes on the changes
- New exported names: `Config.MaxRetryBackoff`, `Entry.Error`, `Entry.LastObs`, `State.Unobserved`, `Deps.InitialLocks`, `SlotsExhausted`, and the `Requeue` action kind. `Requeue` records the slot-exhaustion reason.
- The e2e harness (`internal/e2e/world_test.go` tick) can drop its frozen first tick and both `w.state.Locks =` assignments. Pass `Deps.InitialLocks` instead. Locks after the first tick still need to be set on the state, because Deps only seeds a fresh state.
- A Ready failure on a fresh start does nothing, because there is no state to reconcile.
## Learnings
- Checking the `just` recipe bodies by hand cost time; the image should ship `just`.
- The lint run took about four minutes on first download; start it in the background first.
