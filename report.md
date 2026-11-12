BRANCH: go/k10-eval-scorer
HEAD: aaac3dde37cea7f1ac41a5aba671ca7918532cc5
## Summary
`internal/eval` now has a cascade scorer, a Wilson interval and epochs with reducers (mean, max, pass_at_k, at_least_k), wired into `Run` and `Markdown`, so they are reachable from `cmd/factory eval`. Nothing like them existed on `next`; everything is new, with one commit for both tickets because `runTicket` in `eval.go` uses all three pieces.
## Acceptance
- Ordered scorers stop at first score >= threshold -> TestCascade (rows "first correct short circuits", "threshold lets partial settle", "default threshold: partial does not settle") -> done
- Result records decided_by -> TestCascade, TestScorecardCascadeRecordsDecidedBy (`epochs[].decided_by` in the scorecard JSON) -> done
- Scorecard prints pass rate with 95% Wilson interval -> TestMarkdownShowsWilsonInterval (3 of 4 gives 0.30 to 0.95, operator and customer views), TestWilsonReferenceValues (scipy values from upstream tests) -> done
- Unit tests port the upstream cases; MIT notice kept -> cascade_test.go and wilson_test.go port `test_cascade.py` and `test_metric.py` cases; notices section `UKGovernmentBEIS/inspect_ai@26f6d05` added, provenance test passes -> done
- Eval config takes epochs and reducer -> TestEpochsDefaultToOneAndRejectBadConfig; `Fixture` fields `epochs`, `reducer`, `k`, `scorers` in fixture.yaml -> done
- Scorecard shows per-sample reduced score -> TestFlakyFixtureDiffersByReducer (line "- f/1: reduced score 0.33 over 3 epochs"; JSON `reduced_score`) -> done
- Flaky fixture differs under mean and pass_at_k -> TestFlakyFixtureDiffersByReducer (1 pass in 3 epochs: mean fails at 0.33, pass_at_k=3 and at_least_k=1 pass) -> done
## Found already there
No cascade, Wilson, reducer or epoch code. Kept as is: the scorecard shape, table rows (an existing test pins them, so I added no column), `Compare` and `Diff`.
## Bite-checks
Each mutation was applied once and the named test went red: cascade threshold check, NaN skip, z constant, mean/max/pass_at formulas, at_least `>= 1`, epoch negative guard, base green across epochs, inclusive pass threshold, Wilson line in Markdown, per-epoch reduced line. Two did not go red: the Wilson clamps to [0, 1] (upstream says "float safety only"; the unclamped value is already exactly 0 and 1 for the tested edges, so the mutant is equivalent) and the `total-c < k` shortcut in pass_at_k, which I deleted because the product already gives 1 there.
## Left out
- Clustered stderr and clustered Wilson (needs a Student t quantile, about 80 more lines, no acceptance line needs it, and it would be unreachable from `cmd/factory`).
- Bootstrap (ticket says skip), accuracy metric (the pass rate already is it), match scorers and the log schema (other tickets).
- `pass_k`, `median`, `mode` reducers (ticket lists only mean, max, pass_at_k, at_least_k).
- `--epochs` and `--reducer` CLI flags: `cmd` and `command.go` are outside my area; fixture config carries them.
## Measures
- Non-test Go lines: 21276 before, 21504 after (+228, new code incl. wiring).
- deadcode lines: 70 before, 70 after, identical output.
## API change requests
none
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: required by the provenance test.
- `internal/eval/eval.go` is in the area (the scorecard hook); `Fixture`, `TicketResult` and `Markdown` gained fields and one line. Scorecard JSON gains `epochs` and `reduced_score`; old scorecards still load.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: `gofmt -l` (empty), `go vet ./...`, `go test -race ./...` and with `-tags ee` (no failures), `CGO_ENABLED=0 go build ./cmd/factory` (built), then
golangci-lint v2.13.2 under go1.26.7: `0 issues.`
## Learnings
- `just` missing in cloud sessions: the gate needs `just` installed or a `scripts` fallback, so the "run by hand" step stops costing time.
- First `go test ./...` takes minutes of module downloads; the foreground 120s timeout moves it to the background. Default to background for the first run.
- The system's commit attribution reminder asks for a `Claude-Session:` trailer, but the brief forbids it; brief wins, so the default attribution should leave it out for factory briefs.
- An existing test pins the Markdown table rows, so adding a column cost a round trip; the brief could name pinned formats.
