BRANCH: go/eval-cmd
HEAD: 35a7e94a87adee2b0d3394a7e660ac924e7e204a
## Summary
Added `eval.NewCommand()` (`eval` plus `eval diff`) with an injected runner, a main-green-rate metric, agent/workflow/packs fields on the scorecard, a sample scorecard pair and `evals/README.md`. One commit, pushed.
## Acceptance
- Fake run over two fixtures writes JSON and markdown that agree on every number -> TestEvalRunWritesJSONAndMarkdownThatAgree -> done
- diff table: better, equal, worse on pass rate, worse on tokens, exit code per row -> TestEvalDiffTableAndExit (plus TestEvalDiffRejectsBadInput) -> done
- Scorecard containing a model name fails a check -> TestScorecardsNameNoModel (also rejects model-like --agent in TestEvalRunRejectsBadNames) -> done; proved it bites by putting "claude-opus-4" in the sample (red), then reverted
- evals/README.md under 20 lines -> TestEvalsReadme -> done
## API change requests
none
## Files outside my area
none. Note: `eval.Scorecard.Model` stays as a deprecated, never-set field because `internal/upgrade` (upgrade.go:156, upgrade_test.go:85) still reads it. Whoever owns upgrade should drop it and then the field can go.
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: `test -z "$(gofmt -l .)"` ok, `go vet ./...` ok, `go test -race ./...` all ok, golangci-lint v2.13.2 "0 issues.", `CGO_ENABLED=0 go build ./cmd/factory` ok (binary removed).
## Learnings
- Removing a struct field in a shared package broke internal/upgrade: the brief should say which packages read Scorecard.
- Fixture ticket ids repeat across fixtures (go-stack "1", splitbill "1"), so a fake keyed by id solves both. Ids should be unique per matrix or the key should be fixture/id.
- Not mounted in cmd/: the supervisor mounts `eval.NewCommand(eval.WithRunner(...))`; I did not touch cmd/.
- The Symphony spec (§13.5, absolute token totals) is already cited by the existing tests; I added no new spec-driven behaviour.
