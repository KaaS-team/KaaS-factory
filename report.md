BRANCH: go/k9-stall
HEAD: 3a6d2331cd7e35d79a2ee095223f74159cd61193
## Summary
Ported litellm stall_detector.py (MIT, 7553c4f) to Go as `internal/dispatch/stall`, and hooked it into the local dispatcher's stream-json reader with `Dispatcher.Stalled`. Nothing called the detector before this change; only ticket 2 was built.
## Acceptance
- Go function takes a message or tool-event list and returns a stall verdict -> TestDetect (14 rows: every branch, both message shapes, window, threshold, anchoring) -> done
- Fixtures flag within a set number of repeats -> TestLoopingSessionFlagsAtThreshold (flags at the 3rd repeat, not the 2nd; stream-json shaped fixture `testdata/looping.ndjson`) -> done. The fixture is hand-built in the real stream-json shape, not captured from a live session (none reachable here).
- No false positive on a clean eval session -> TestCleanSessionIsNotStalled (checks every prefix of `testdata/clean.ndjson`) -> done, same caveat on the fixture
- Hook reads session events -> TestStalledReadsRepeatedFailingToolCallsFromTheStream (local dispatcher) -> done
- Bite-checks: removing `p.turns.Feed` fails the local test; dropping the repeat test, the newest-errored anchor, or the string-argument decoding each fail TestDetect. Removing the `Role != "assistant"` skip did not fail any test: it is redundant because user turns carry no tool_use blocks, so I left the line as a guard and did not claim it.
- Found already on base: no stall detection of any kind (only the `stall_after` config and the reconcile no-push stall). Nothing to keep.
- Tickets 1 and 3 belong to other sessions; not touched.
## API change requests
`Stalled` is not yet called by anything outside tests. To make it reachable from `cmd/factory`, reconcile (or core) should type-assert an optional `Stalled(api.Session) (bool, error)` on the dispatcher and mark the slot `PhaseStalled`, as it does for no-push stalls. I did not touch `internal/api` or `internal/reconcile`. Thresholds are constants in `local.go` (3 repeats in the last 8 calls); the upstream takes them from the caller.
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: required section for the ported file (provenance test).
- `internal/dispatch/local/local.go` and `local_test.go`: the smallest hook where session events are read.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt clean, `go vet ./...`, golangci-lint v2.13.2 under go1.26.7 ("0 issues"), `go test -race ./...` all ok (last lines: `ok  github.com/KaaS-team/factory/pkg/agentrun`, `ok  .../pkg/sandbox`), the same with `-tags ee`, and `CGO_ENABLED=0 go build ./cmd/factory` ok.
Measures: non-test Go lines (tracked files, excluding src/) 21276 before, 21456 after including the new untracked file. Deadcode lines: 75 before, 70 after the change (the before and after runs were not on identical trees in my first run, so treat the drop as unexplained, not a gain).
## Learnings
- `git clone` of litellm exceeds the 120s tool timeout; start it in the background.
- The brief gate needs `just`, which is missing in cloud sessions; the recipe bodies should be a script.
- golangci-lint's first run downloads many modules and takes minutes; run it in the background at once.
