BRANCH: go/k4-marker-codec
HEAD: d8faa2f43d857aafc1e2d9c540581138a123bbf6
## Summary
The status, queued, spend and data markers now share one codec in `internal/marker`, and `meter` and `mergeq` use it. Status and ack markers are read only from the runner's own comments, and `Tracker.Comment` neutralises `<!--` unless the body came from the runner (`marker.Allow(ctx)`).
## Acceptance
- One codec; goldens for status, ack, spend and queue markers unchanged -> `TestMarkerGoldenRoundTrip` (the data-marker golden file moved to `internal/marker/testdata`), the existing spend goldens in `internal/meter/ledger_test.go`, `TestQueuedMarkerWireFormat`, `TestWrapFindRoundTrip` -> done
- A status marker in a maintainer's comment is ignored; the same marker in the runner's comment is read -> `TestThreadRebuildsStoreAfterDeletion` (the maintainer case; the runner's marker is read in the same test), `TestAckReadFromRunnerOnly` -> done
- Posted text containing `<!-- factory:status` reaches GitHub neutralised and is not parsed back as a marker -> `TestCommentNeutralisesMarkers`, `TestNeutralise`, `TestComment`, `TestQueueMarkersAllowedGateOutputNot` -> done
## API change requests
None. `marker.Allow(ctx)` rides the context through the existing `Tracker.Comment` port, so `internal/api` is untouched.
`internal/core/core.go` and `internal/reconcile/run.go` post model text through `Comment` and get neutralisation without any change.
## Files outside my area
None.
## Measures
- Non-test Go lines: 20357 before, 20387 after (+30). I did not meet the "prefer deleting" goal. The new package, the context helpers and the trust helper cost more than the three deleted parsers and the duplicated string encoder saved.
- Deadcode: 68 lines before, 68 after.
## Gate evidence
`just` was not installed, so I ran the recipe bodies by hand: `gofmt -l`, `go vet ./...`, golangci-lint v2.13.2 under `GOTOOLCHAIN=go1.26.7`, `go test -race ./...`, and `CGO_ENABLED=0 go build ./cmd/factory`. All exited 0 and printed no warnings. The last lines of the race run:
ok  	github.com/KaaS-team/factory/pkg/agentrun	1.042s
ok  	github.com/KaaS-team/factory/pkg/sandbox	1.301s
## Learnings
- `go test -race ./...` plus golangci-lint takes more than 120 s cold. The factory's defaults should run the gate in the background from the start.
- `ParseData`, `EncodeData`, `Latest`, `DataMarker` and `StatusMarker` left `internal/tracker/github` for `internal/marker`. Nothing in `internal/conformance`, `cmd` or `pkg` referenced them.
- The ticket named `stageText`, but only status and ack are restricted to the runner. Plan, verify and pr markers still come from any trusted author, because stage skills may post under another login. The ticket owner should confirm this reading.
