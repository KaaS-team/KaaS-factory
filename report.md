BRANCH: go/report
HEAD: fc1abe3a034b9af4f9174427dd83467017538387
## Summary
Added `internal/report`: `Build(ctx, Source, Window)` over a narrow `Source`, the five definitions in `definitions.go`, markdown and JSON renderers that print one rounded `View`, and `NewCommand()` for `factory report [--since] [--json] [--by] [--out]`.
## Acceptance
- Each definition has a table test with a hand-computed fixture row -> TestMerged, TestTokens, TestTicketTokensCountsFailedAttempts, TestRework, TestHumanTouches, TestCycleTime -> done
- Failed attempts count toward tokens per merged PR; a ticket that never merged adds to spend but not to merged PRs -> TestTicketTokensCountsFailedAttempts, TestBuildTotals, TestBuildUnmergedAddsSpendNotPRs -> done (mutating TicketTokens to count only the last attempt turned these red)
- `--by team` groups correctly over a fixture with two teams (golden) -> TestGoldenByTeam (testdata/by_team.golden.md and .json, checked by hand), TestBuildGroups -> done
- JSON and markdown agree on every number -> TestJSONAndMarkdownAgree (all three groupings, every cell) -> done
- Operator-only: refuses `.github/` and PR body paths -> TestCommandOutRefusals (including a symlink into `.github`) -> done (disabling the check turned it red)
## API change requests
- None to `internal/api`. The report needs a `Source` that supplies, per ticket: team, pack, merge time, first dispatch time, chatops command count and manual push count. The store has no table for the merge time, pack, team or the two human-touch counts, and `meter.Spend` ledger comments carry no per-attempt tokens. Someone needs to write the `Source` adapter over the store, tracker thread and ledger.
## Files outside my area
- None. Everything is under `internal/report/`.
- `cmd/factory/main.go` does not register `report.NewCommand(report.WithSource(...))` yet; that is outside my area and needs the adapter above first. Without a source the command returns "no ticket source configured".
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand in one `&&` chain: gofmt, `go vet ./...`, golangci-lint v2.13.2 on go1.26.7, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`.
```
0 issues.
ok  	github.com/KaaS-team/factory/internal/report	1.031s
ok  	github.com/KaaS-team/factory/internal/store	1.228s
ok  	github.com/KaaS-team/factory/internal/tracker/vendorkit	1.083s
BUILD_OK
```
## Learnings
- `gofmt -l` exits 0 even when it lists files, so chaining it with `&&` does not gate. The second commit went out with an unformatted test file, fixed in the third. The brief's gate recipe should use `test -z "$(gofmt -l ...)"`.
- The first `go run golangci-lint` downloads the whole module graph and passes the 120 s tool timeout. The brief should tell sessions to run the gate in the background.
- The brief's `Build(ctx, Source, Window)` has no room for `--by`, so `Build` computes all three groupings and `Report.Rows(by)` picks one.
- Definitions I chose where the ticket was silent: tokens = input + output + cache read + cache write; rework rate = attempts above one per merged PR; cost counts merged and unmerged spend.
