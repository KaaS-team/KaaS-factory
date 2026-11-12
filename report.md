BRANCH: go/k10-scan-edit
HEAD: 9b97ee42f64ee0b2135e418672840ca9a1fdd970
## Summary
New `internal/graph/scanedit/`: Scan writes an accumulator to disk read-only, Edit reads it and rewrites files, each file call has a deadline (a hung file is abandoned and reported, the run goes on), and rows go to a `file,step,result,tokens` CSV that folds into an `eval.TicketResult`. The package is not yet reachable from `cmd/factory` (see API change requests).
## Acceptance
- Cross-file rename fixture passes eval -> TestCrossFileRename (scan leaves files untouched, edit rewrites use and declaration files) -> done
- A hung file is abandoned and reported, the run continues -> TestHungFileAbandoned (timeout row, hung file unchanged, later file edited), plus TestErrorsAndConflicts and TestCanceledRunStops -> done
- The CSV feeds the scorecard -> TestCSVFeedsScorecard (header, quoting, roundtrip, Scorecard fold) -> done
- Bite-check: reverting the deadline select (test times out), the conflict check (TestErrorsAndConflicts fails), the error-path write guard (TestHungFileAbandoned and TestErrorsAndConflicts fail) and the scorecard failure flag (TestCSVFeedsScorecard fails) each turned a test red. Reverting the "edit needs accumulator" return is an equivalent mutant (json.Unmarshal of empty input still errors); its test passes either way.
## API change requests
- Wire `scanedit.Scan`/`Edit`/`WriteCSV` into a `cmd/factory` subcommand or a graph node kind (outside my area). Until then deadcode lists the exports as unreachable.
- The CSV has one tokens column, so `Scorecard` puts the sum in InputTokens; an input/output split needs a wider CSV.
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: the `openrewrite/rewrite@90219c5` section the provenance test requires.
## Measures
- Non-test Go lines, command from the brief: 21276 before, 21493 after (+217).
- Deadcode: 70 before, 78 after (+8, the new exports, unreachable until wired).
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt, `go vet ./...`, golangci-lint v2.13.2 on `./internal/graph/...` (0 issues), `go test -race ./...`, the same with `-tags ee`, and `CGO_ENABLED=0 go build ./cmd/factory`. All exited 0. Last lines:
ok  	github.com/KaaS-team/factory/pkg/agentrun	1.015s
ok  	github.com/KaaS-team/factory/pkg/sandbox	1.227s
[exited with code 0]
Full-repo golangci-lint was not run, only the graph packages.
## Learnings
- `just` is not installed in cloud sessions; the factory image should ship it.
- Deadcode and the gate take over 2 minutes; run them in the background from the start.
- The brief's "reachable from cmd/factory" conflicts with "never edit cmd/"; a ticket should name the wiring owner.
