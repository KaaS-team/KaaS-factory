BRANCH: go/k8-steer-queue
HEAD: 1a82370b197341b739f2d5339e05e11c278d8c97
## Summary
Added `internal/dispatch/local/input/` (ported ring buffer, stability-gated queue, bracketed-paste and raw framing, SIGINT-then-kill close) and the smallest hook in `internal/dispatch/local`: `Steer` writes through the gate for presets with `Steer: true`, and `Cancel` sends SIGINT to the process group before the kill. Ticket 3 (Host/Origin allow-list) is not mine and was not touched.
## Acceptance
- Ticket 1: ring buffer of N snapshots, send only when identical, fake clock -> TestGateSendsOnlyWhenSnapshotsAreIdentical, TestRingBufferKeepsNewestOldestFirst, TestSendStopsWhenContextEnds -> done
- Ticket 2: multi-line prompt delivered intact -> TestSteerDeliversMultiLinePromptIntact, TestFrame -> done
- Ticket 2: selection prompt receives raw keys -> TestSteerRawKeysAreNotWrapped, TestFrame -> done
- Ticket 2: process gone within timeout -> TestClose, TestCancelSendsSIGINTThenKills (honours and ignores SIGINT) -> done
- Bite-checks, each fix reverted once: stable() forced true failed the gate test; unwrapped paste failed TestFrame and the multi-line test; removed raw branch failed TestFrame and the raw test; `interruptGroup` swapped for an error failed "honours SIGINT". Skipping the interrupt inside `input.Close` made TestClose hang until the timeout, so it went red by timeout rather than by assertion.
- Left out, with reason: `diff.go` (screen diff for message extraction) is not ported: nothing reachable from `cmd/factory` would call it, and `local` has no terminal emulator to produce screens. `parseAllowedHosts` and `parseAllowedOrigins` belong to ticket 3.
## API change requests
none. Steer's message string carries the mode: a message starting with `input.RawPrefix` is sent as raw keys. A typed raw method on `api.Dispatcher` would be cleaner but is outside my area.
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: the required `## coder/agentapi@7c468d5` section.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand with GOTOOLCHAIN=go1.26.7: `gofmt -l .` (clean), `go vet ./...` (clean), golangci-lint v2.13.2 `run ./...` -> `0 issues.`, `go test -race ./...` (all packages ok, nothing failed), `CGO_ENABLED=0 go build ./cmd/factory` (ok).
Measures. Non-test Go lines: 21276 before, 21494 after (+218 counting uncommitted test-free files). Deadcode lines: 75 before, 70 after, and no entry in `internal/dispatch/local`. The 75 baseline was taken on the first run, so it may include download noise.
## Learnings
- `Steer` on the pinned `claude -p` preset stays unsupported: there is no stdin channel and no pty, so the gate is reachable only for presets that opt in with `Steer: true`.
- Deadcode flagged an exported `Raw` helper and `Capacity` that only tests called; a constant avoids that.
- Fake-clock tests race the ticker unless they wait for the snapshot count before advancing.
- `pkill` is blocked by the sandbox; use TaskStop for runaway background tests.
