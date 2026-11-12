BRANCH: go/k3f-state
HEAD: f0dd259e343739a7cf622da6861b7b99c877ed91
## Summary
One loop survived: `core` drives `reconcile.Tick`, which calls `Decide` (Symphony 8.1) and the capped backoff (8.4); the unstarted `reconcile.Run` duplicate, its `drain` and `Deps.Cancels` are gone. The marker codec, chatops, trust and the PR body renderer are now reached from `core` through three optional tracker interfaces in `internal/observe` (`Commander`, `Recorder`, `PROpener`), and all 29 listed functions are either reachable or deleted.
Measures (non-test Go, outside `src/`): 20032 lines before, 20311 after (+279, the new `thread.go` wiring outweighs the deletions). Deadcode count for my packages: 29 before, 0 after (whole repo 232 lines before, 201 after).
## Acceptance
- One loop; the report names which survived and why -> `core.Run` plus `reconcile.Tick`/`Decide` survived because `core` already ran them and adds events, meter and merge queue around them; `reconcile.Run` was never started. `Backoff` became `Config.Backoff` (still called by `Decide`). Symphony table tests and `internal/conformance` stay green (`TestBackoff`, `TestTickStopsOnCancel`, `Test17_4_BackoffFormula`) -> done
- Observation reads marker data from the issue thread; a fake thread with a status marker rebuilds the same state after the store is deleted -> `TestThreadRebuildsStoreAfterDeletion` (loop writes the status comment, new store `Rebuild`s, FirstDispatch and ChatopsCommands come back, a forged marker from an outsider restores nothing, two rebuilds are equal) -> done. Note: the time recorded is the first push the loop sees, not the dispatch call, so a shadow run (which never pushes) writes no comment (`TestRunShadowMergesNothing` demanded that).
- `/factory retry` from an untrusted author changes nothing, from a trusted one retries, through the loop -> `TestLoopRetryObeysTrustedAuthorsOnly` (real github tracker over a stateful fake GitHub, `core.Tick`; retry starts attempt 2, is acknowledged on the thread, does not run twice) -> done
- The PR the loop opens uses `RenderPRBody`; body has no token count, cost or model -> `TestLoopOpensPRWithRenderedBody` (thread text with model, token, cost and claude.ai lines is redacted; draft, head, base, title checked; a forged `pr` marker is ignored) -> done
Bite proofs (code broken once, test went red, reverted): `Trust.Trusted` always true -> retry test red; `Thread` ignoring the status marker -> rebuild test red; `Redact` bypassed -> PR body test red; marker trust check removed -> both forged-marker assertions red.
## API change requests
none. The three narrow interfaces live in `internal/observe/commands.go`.
## Files outside my area
- `internal/conformance/sec17_4_test.go`: three lines, `reconcile.Backoff(n)` became `(reconcile.Config{}).Backoff(n)`, because the Symphony 17.4 suite pinned the free function and `Backoff` now lives on `Config`.
- `internal/tracker/vendorkit/codec.go` and `codec_test.go`: deleted unused `KeyNumber` and its test (it was on my list).
## Gate evidence
`just` is not installed here, so the recipe bodies were run by hand with `GOTOOLCHAIN=go1.26.7`: `gofmt -l .` empty, `go vet ./...` clean, `golangci-lint v2.13.2 run ./...` -> `0 issues.`, `go test -race ./...` every package `ok` (last lines: `ok  github.com/KaaS-team/factory/pkg/agentrun 1.037s`, `ok  github.com/KaaS-team/factory/pkg/sandbox 1.264s`), `CGO_ENABLED=0 go build ./cmd/factory` -> `BUILD-OK`.
## Left out, on purpose
- Chatops scans tickets the running process tracks plus ones it escalated; a ticket parked before a restart is not scanned until it is tracked again. Listing parked tickets needs a tracker read I did not add.
- `approve` and `revise` are parsed but the loop acts only on `retry` and `cancel`; plan approval is not a Go loop feature yet. `--force` and a retry step are parsed and ignored.
- `ManualPushes` is not derived from the thread.
- Whether `store.Rebuild` itself has a product caller is the store owner's question; `Tracker.Thread` is reached only through it.
- `LeaseRef` (no caller) was deleted; `NewLeaseCommit`, `UpdateRef`, `PushLease` stay.
- `PRParts` lost `Tasks`, `QA`, `Shots`, `TryIt` and their section renderers: nothing in Go produces them.
## Learnings
- `go run deadcode@v0.39.0` fails under the default Go 1.24 toolchain; `GOTOOLCHAIN=go1.26.7` fixes it. Say so in the setup.
- The Symphony conformance suite pins exported names across areas, so a deletion in `reconcile` touches `internal/conformance`; grant that file to the reconcile area.
- Strict request-count tests (`TestSetPhase`) make writes inside an existing method costly; adding an optional interface and a call from the loop avoided editing them.
- Wiring adds lines: the brief's 8K budget cannot be met by wiring alone, only by deleting whole subsystems.
