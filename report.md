BRANCH: go/k3f-meter
HEAD: 6ae5c57c20263738beec8b93b0f033928b6b0cee
## Summary
Core now adds each attempt's usage to one editable spend comment per ticket (replay safe), the GitHub tracker edits that comment in place, and `factory report` reads it. `CloudUsage` is deleted as a second delta tracker the loop never used.
## Acceptance
- Two attempts leave one ledger comment, totals equal the sum, replay does not double count -> core TestLedgerTwoAttemptsOneComment, meter TestLedgerAddTwoAttemptsNoDoubleCount (includes a restart) -> done
- Budget table through the loop: under 80% nothing, 80% one steer, 100% stop and needs-human -> core TestBudgetTable (TestBudgetSteersThenStops already covered the loop) -> done
- `factory report` prints tokens per merged PR from that state -> report TestCommandPrintsTokensFromLedger (180 tokens, 1 PR) -> done
Bite checks: removing the core call fails the core test, summing instead of max fails the meter and core tests, disabling the ledger read fails the report test.
## API change requests
Tracker has no way to edit a comment. I defined `meter.Thread` (SpendComment, PutSpendComment) and the core type-asserts the tracker for it. Please add it to `internal/api` as an optional Tracker interface and to `porttest.Tracker`; the core test uses a local wrapper meanwhile. Linear and Jira do not implement it, so they record no ledger yet.
## Files outside my area
- internal/tracker/github/spend.go and spend_test.go: GitHub implementation of `meter.Thread`. Reads and edits only comments written by the tracker's own login, so a forged marker is ignored.
- cmd/factory/main.go: 5 lines, report gets `meter.Ledger` over the GitHub tracker when one is configured.
## Gate evidence
`just` missing, so I ran the recipe bodies: `gofmt -l .` empty, `go vet ./...` clean, golangci-lint v2.13.2 `0 issues.`, `go test -race ./...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` ok.
Measured: non-test Go outside src/ 19959 lines after (before not measured); deadcode count for internal/meter and internal/report is 0 (13 listed functions before).
Kept, with reason: `report.WithNow` is still set only by tests; it gives the window test a fixed clock.
Cost accounting is approximate: a holder's cost grows only when an attempt's tokens grow, because the wire format has no per-attempt cost.
## Learnings
- Shadow runs must write nothing: the smoke test caught a zero-usage ledger write. Skip writes with nothing to record.
- `go build ./cmd/factory` drops a `factory` binary in the repo root; use `-o /dev/null`.
