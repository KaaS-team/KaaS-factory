BRANCH: go/tui
HEAD: ad3482d893e9ccd448bb21a26abf7865830f2c23
## Summary
`internal/tui` adds the board, queue and ticket timeline screens as a client of `api.Control`, plus a `board` cobra command. Libraries: bubbletea v2.1.1, bubbles v2.2.1, lipgloss v2.0.6 (not the latest v2.1.0, see Files outside my area).
## Acceptance
- Golden view test, 100x30, ANSI stripped -> TestGoldenBoard100x30 -> done
- Each key produces the expected Control call or screen change -> TestKeysCallControl (16 rows), TestQuitKey -> done
- `stalled` event marks the card; `merged` event removes it from the queue screen -> TestStalledEventMarksCard, TestMergedEventLeavesQueue -> done
- Usage over 80 percent renders the warning style, asserted on a marker -> TestUsageBarWarning (marker "!", boundary at exactly 80 percent is not a warning) -> done
## API change requests
- `NewCommand()` has no Control to use, and no Control implementation exists on `next`. I added `tui.WithControl(ctx, ctl)`; the supervisor must call `cmd.SetContext(tui.WithControl(ctx, ctl))` when wiring `board` into cmd. Without it the command returns an error.
- `Events` carries only new events, so a timeline starts empty on launch. A Control method returning a ticket's past events would fix that.
## Files outside my area
- `go.mod`, `go.sum`: the three charm.land dependencies the ticket names. lipgloss v2.1.0 requires go 1.26.7 and would raise the `go` directive from 1.26.0 for every session, so I pinned v2.0.6 and kept `go 1.26.0`.
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt -l (clean), go vet ./... (clean), golangci-lint v2.13.2 under go1.26.7 (`0 issues.`), `go test -race ./...` (every package `ok`, including `internal/tui` and `internal/provenance`), `CGO_ENABLED=0 go build ./cmd/factory` (ok).
## Learnings
- `just` is not installed in the cloud image; the brief's by-hand recipes worked.
- The latest lipgloss needs a newer `go` directive than `next` pins; tickets that name libraries should say whether to pin below the latest to keep the directive.
- Testing a Bubble Tea model works best by calling Update with fake messages and running each Cmd directly; avoid running Init as a whole, because its blocking event wait leaks a goroutine that steals test events.
