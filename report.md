BRANCH: go/history
HEAD: 19505c8da436c8c271b589cd647d807b0b879eb6
## Summary
`api.Historian` is added and implemented by core as an in-memory log of the last 500 events per ticket, filled from the hub's emit path; a restart loses it. `porttest.Control` (Control plus Historian) now backs the TUI, MCP and dashboard tests, and all three clients load history first and then follow live events.
## Acceptance
- Core: 600 events for one ticket keep the last 500 in order; two tickets do not mix (-race) -> TestHistoryKeepsLast500InOrderAndTicketsDoNotMix -> done
- Opening a ticket timeline in the TUI with a Historian shows past events; a live event after that appears once -> TestTimelineLoadsHistoryThenFollowsLiveOnce, TestTimelineHistoryKeepsLiveEventsSeenBeforeItLoaded, TestTimelineWithoutHistorianStillWorks -> done
- MCP resource factory://ticket/{id} includes history; a Control without Historian still works and says history is unavailable -> TestTicketResourceHistory, TestStatusForOneTicketIncludesHistory (status takes an optional `ticket`) -> done
- Dashboard ticket page renders history (golden HTML fragment) -> TestTicketPageRendersHistoryGolden (three goldens in internal/dashboard/testdata) -> done
- porttest.Control satisfies both interfaces (compile-time assertion) and at least two clients' tests use it -> `var _ api.Control/api.Historian` in control.go, TestControlSatisfiesBothAndControlOnlyHidesHistory; tui, mcp and dashboard tests all use it -> done
## API change requests
none. Core has no way to number events, so clients dedupe by (time, kind, data). A sequence number on Event would make that exact.
## Files outside my area
- internal/core/hub.go: two lines (a `hist` field and `h.hist.add(ev)` in emit). The log has to be fed from the one emit path.
- internal/dashboard/templates/ticket.html and internal/dashboard/testdata/*: inside the dashboard package.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: `test -z "$(gofmt -l .)"`, `go vet ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory` (output to /tmp, no binary left in the tree), and golangci-lint v2.13.2 under GOTOOLCHAIN=go1.26.7.
- golangci-lint: `0 issues.`
- go test -race ./...: every package `ok`, none FAIL.
- build: `build ok`
Proof the new tests bite (each break reverted): core trim disabled -> "A kept 600 events, want 500"; TUI dedupe disabled -> "history event duplicated by the stream"; MCP history lookup disabled -> TestResources, TestTicketResourceHistory and TestStatusForOneTicketIncludesHistory fail; dashboard hidden-kind filter disabled -> golden test fails.
## Learnings
- The TUI test helper `emit` leaks a goroutine blocked on the event channel (runCmd timeout), which swallows the next pushed event. A second `emit` in one test silently does nothing, so TestTimelineShowsTicketEvents passes for the wrong reason. My tests apply events with `m.Update(eventMsg(e))` instead. The helper should be fixed.
- A TUI/dashboard client that subscribes before reading history can see an event in both; without a sequence number on Event, dedupe is by (time, kind, data), which would drop two genuinely identical events at the same instant.
- Dashboard gap: events emitted between page render and the browser's SSE connect are not shown until reload. A `/ticket/{id}` fragment refetch on connect would close it; left out of scope.
- MCP `factory://ticket/{id}` no longer drains the live stream for 200 ms; with no Historian it reports history unavailable instead.
- Cold golangci-lint took over 120 s; running it in the background from the start meant it was warm for the final run.
