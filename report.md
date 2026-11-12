BRANCH: go/k4-observe-parked
HEAD: 7eb42b01f93d7414f99c271b8b931a72162fe7e5
## Summary
A restart with an empty store now scans tickets parked needs-human, ManualPushes comes from push events by other logins, and `store.Rebuild` is called at startup when the store is empty (kept, not deleted). Most of the change had to land outside `observe` and `store`, because the scan, the thread read and the startup call live in `core`, the GitHub tracker and `cmd/factory`.
## Acceptance
- After a restart with an empty store, a parked ticket is scanned for /factory commands -> TestLoopScansParkedTicketAfterRestart (internal/tracker/github/loop_test.go; saw it fail first) -> done. It uses the stateful GitHub hub fake, not the porttest tracker.
- ManualPushes derived from pushes not made by the runner's login -> TestThreadCountsManualPushes (same file; saw it fail first) -> done
- store.Rebuild called on startup when the cache is empty, or deleted -> TestRebuildIfEmpty (internal/store/store_test.go) -> done. Called, not deleted: `core` rebuilds only the running set, and Rebuild is the only path that restores merge times and touch counts for `factory report`. The call is wired in `newControl` in cmd/factory/control.go, with no test of its own. It runs for the GitHub tracker only, because other trackers have a not-configured observer.
## Measures
- Non-test Go lines: before 20357, after 20419 (+62).
- Deadcode: before 68 findings, after 68. The raw `| wc -l` includes download lines on stderr: 73 before, and 68 after with `2>/dev/null`.
## API change requests
none. I added an optional `observe.Parker` interface in my own area instead.
## Files outside my area
- internal/core/core.go: `recover` marks tickets from `Parker.Parked` as parked.
- internal/tracker/github/tracker.go: new `Parked`; Ready and Parked share one `labeled` helper.
- internal/tracker/github/thread.go: `manualPushes` feeds `Thread`.
- internal/tracker/github/loop_test.go: two tests, plus a `/events` route and a pushes field on the hub fake.
- cmd/factory/control.go: `newControl` calls `RebuildIfEmpty`.
Also: `store.Lister` was deleted; it duplicated `api.Lister`.
## Gate evidence
`just` is not installed here, so I ran the recipe bodies by hand:
gofmt -l: clean; go vet ./...: clean; golangci-lint v2.13.2 run ./...: `0 issues.`; go test -race ./...: all ok; CGO_ENABLED=0 go build ./cmd/factory: BUILD-OK; conformance and provenance tests ok.
## Learnings
- Wiring costs lines: +62 against the ticket's "prefer deleting"; the only deletion was store.Lister plus the Ready loop folded into `labeled`.
- Rebuild does not include parked tickets, so their spend rows are lost after a rebuild. I left that out of scope.
- ManualPushes uses repo push events, which GitHub keeps for 90 days. That covers every ticket Rebuild lists, but a ticket parked for more than 90 days would count zero.
- The ticket's area list left out the core, tracker and cmd files that restart scanning needs. The brief should name them.
- Commits carry no Claude-Session trailer, per the brief.
