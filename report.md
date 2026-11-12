BRANCH: go/eval
HEAD: ea036d2ece89f79a996f2d65930dd751f2f1e439
## Summary
Added `internal/eval`: fixture loader, `Run` with injected dispatch, gate and hidden-test interfaces, scorecard (`factory.scorecard/v1`) in JSON and markdown, and `Compare`. Two seed fixtures (go-stack, splitbill) are under `internal/eval/testdata/`.
## Acceptance
- 3 of 4 pass gives 0.75 and tokens per merged PR = total / 3 -> TestScorecardPassRateAndTokensPerMergedPR -> done
- Repeated absolute usage counts once -> TestTokenAccountingAbsoluteTotals -> done
- Compare: lower pass rate worse, 5% not worse, 15% worse -> TestCompare -> done
- JSON round trip, customer markdown has no model or cost -> TestScorecardRoundTripAndCustomerView -> done
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt -l (clean), go vet ./... (clean), golangci-lint v2.13.2 via go run ("0 issues."), go test -race ./... (all packages ok), CGO_ENABLED=0 go build ./cmd/factory (built).
## Learnings
- KaaS-team/playbooks is not clonable from a cloud session (no credentials), so Symphony §13.5/§17/§18 were not read. The token rule follows the brief and `api.Usage` comment only. Provide the spec in the repo or attach it.
- No YAML dependency exists and the ticket names none, so `fixture.yaml` holds JSON (valid YAML). Name a YAML library in the ticket if real YAML is wanted.
- I made one commit, not one per acceptance group, since all four groups live in one small package. Tests were written first and seen failing to compile before the code.
- Merged is defined as hidden test passes and base stayed green; human touches per PR counts merged tickets only.
