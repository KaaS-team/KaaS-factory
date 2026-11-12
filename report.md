BRANCH: go/conformance
HEAD: 42d8aedd29b881e7bd96ef728f474896d5f922bc
## Summary
New package `internal/conformance`: 18 `Test17_` tests (plus 3 `Test17Mapping` structure tests) against reconcile, pick and the porttest fakes. `checklist.go` maps all 86 section 17 rows and 18 section 18.1 lines to a test or a reason. The package runs in about 1 second (fake clock). `just` is not installed here, so I ran its recipe bodies by hand (gofmt, vet, golangci-lint v2.13.2 on go1.26.7, `go test -race ./...`, static build).
## Acceptance
- Every section 17 row is a test or not applicable with a reason -> `Rows17()` in checklist.go, checked by Test17MappingEveryItemHasATestOrAReason -> done (11 rows have tests, the rest are not applicable; see Notes in the table for partial coverage)
- Mapping test fails when an item has no test -> Test17MappingEveryItemHasATestOrAReason, Test17MappingEveryTestIsMapped, Test17MappingCountsMatchSpec -> done. Shown failing once: pointing "Workspace manager" at Test17_9_Missing gave `18.1 "Workspace manager": maps to Test17_9_Missing, which does not exist`.
- Backoff 8.4 for attempts 1 to 8 including the 5 minute cap -> Test17_4_BackoffFormula (against an independent doubling formula) and Test17_4_AbnormalExitBackoff (through Tick, attempts 1 to 8, early and exact due time) -> done for the 5 minute cap. The cap is fixed; `agent.max_retry_backoff_ms` has no config field (see requests).
- Tick order 8.1 from a recorded call log -> Test17_4_TickOrder -> done (Ready, then Observe, then all stops, then claim, then dispatch in rank order). Step 2, preflight validation, does not exist in reconcile.
- Runs under 10 seconds -> `go test ./internal/conformance -run Test17 -count=1` about 0.3 s; with -race 1.0 s of test time -> done
Mutation checks (temporary, reverted): backoff cap, rank order, terminal detection, stall threshold, retry attempt number, slot counting each turn at least one test red.
## API change requests
- reconcile.Config needs `MaxRetryBackoff` so the cap in 8.4 is configurable (Backoff is fixed at 5m).
- reconcile.Entry should store the retry error text; 17.4 wants attempt, due time, identifier and error. Slot exhaustion should record `no available orchestrator slots` there.
- Finding, not asserted: when `Observer.Observe` fails for a running ticket, reconcileOne sees no observation and measures stall from StartedAt, so a transient observer error can cancel and retry a healthy session once StallAfter has passed (checked with a scratch test, phase=retry, cancels=[x-a1]). Spec 8.5 says keep workers running on refresh failure.
- Finding: a tracker Ready failure skips the whole tick, including stall detection. Spec 8.1 says reconciliation still happens first.
- Divergences recorded in the table: priority 0 ranks first (spec ranks 1..4 first); no dispatchable or required-label filter in reconcile; no continuation retry after a normal exit (completion is read from git); no snapshot API; no workspace cleanup in reconcile.
## Files outside my area
none
## Gate evidence
gofmt clean; go vet clean; golangci-lint `0 issues.`; `go test -race ./...` all ok (tail: `ok github.com/KaaS-team/factory/internal/tracker/vendorkit 1.066s`); `CGO_ENABLED=0 go build ./cmd/factory` ok, exit 0. `just check` itself was not run because `just` is missing.
## Learnings
- `just` is absent in the cloud image; the factory default should install it or ship a script that runs the recipes.
- The first `go` call downloads the Go 1.26 toolchain, and the lint run needs 1.26.7; say so in the setup step.
- All 15 tests passed on first run, so the red step came from mutating the code under test; the brief should say that is acceptable for conformance tests.
- Sections 17.1 to 17.3 and 17.5 to 17.8 belong to other packages; this suite marks them not applicable and proves nothing about them.
- One commit instead of one per acceptance group: the structure test needs every named test present to pass.
