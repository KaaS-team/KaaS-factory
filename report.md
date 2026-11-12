BRANCH: go/k4-tui-board
HEAD: 8abedda9bc4ae6d377d1a6ddd0c95e95b853eb61
## Summary
Added a waves screen (DAG depth from Ticket.BlockedBy) and gate output plus ejection reasons on the queue screen. The board already had cards, stall flag, budget bar and the fire-budget footer. The TUI imports only internal/api, now pinned by a test.
## Acceptance
- teatest or golden for board, waves, queue from a fake event stream -> TestGoldenBoard100x30, TestGoldenWaves100x30, TestGoldenQueue100x30, TestWaves, TestQueueShowsEjectionReason -> done
- Nothing in internal/tui imports an internal package but internal/api -> TestImportsOnlyAPI (go list -deps) -> done
- Unused views and helpers deleted -> done (firstBoardTicket removed; deadcode reports nothing in internal/tui)
## Measures
- Non-test Go lines: 20357 before, 20451 after (+94, new screens, not wiring)
- Deadcode lines: 68 before, 68 after
## API change requests
- The core's gate event carries only {"runs": n}. The queue screen shows data["log"] (tail) when present. Please have core emit KindGate with the gate log tail under "log". Until then it shows the run count and per-ticket "gate failed" reasons.
## Files outside my area
none
## Gate evidence
just is not installed; ran its recipe bodies by hand: gofmt -l clean, go vet ./... clean, golangci-lint v2.13.2 "0 issues.", go test -race ./... no failures, CGO_ENABLED=0 go build ./cmd/factory BUILD_OK.
## Learnings
- The red step for new tests was a compile failure (new symbols), not an assertion failure.
- just is missing in cloud sessions; the first golangci-lint run exceeds the 120s tool timeout, so run the gate in the background.
- Symphony section numbers cited in test comments (8.2, 13.7) were not checked against the spec file.
