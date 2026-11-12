BRANCH: go/k4-eval-matrix
HEAD: 51ce9614c13d6067501998de7e34aa3f3329a803
## Summary
`factory eval --workflow X --agent Y` now runs the fixture matrix through the `local` dispatcher by default and writes the scorecard. Fixtures moved to `evals/fixtures` (go, bun, uv, and a two-ticket repo), and `eval.Diff` gives better, same or worse per metric.
## Acceptance
- Fake agent applying a known patch reports 1/1, one applying nothing 0/1 -> TestLocalRunnerFakeAgentPassRate (plus TestEvalCommandDefaultRunnerUsesLocalDispatcher, TestLocalRunnerHidesTestsFromAgent) -> done
- Two runs diff into better/same/worse per metric; `packs upgrade` can call it -> TestDiffVerdictPerMetric, TestEvalDiffTableAndExit; exported `eval.Diff(old, next Scorecard) string` -> done (I did not edit internal/upgrade; it can call `eval.Diff`)
- No network, no real agent in tests -> fake shell agent on PATH or via Config.Binary; the only fixture run in tests is go-stack, whose gate and hidden commands are `go vet` and `go test` -> done
## Measures
- Non-test Go lines: before 20357, after 20523 (+166, mostly internal/eval/runner.go; the old table code in command.go was replaced by Diff). Over budget, nothing else to delete inside my area.
- Deadcode: before 68, after 68. WithRunner and WithNow are listed but were already unreachable; the new code is reachable from `cmd/factory` through `eval.NewCommand()`'s default runner.
## API change requests
none
## Files outside my area
- docs/cli-reference.md: the generated `--fixtures` default changed to `evals/fixtures`; `TestCLIReferenceFresh` fails otherwise.
- internal/conformance: no rename, nothing to fix.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt -l . (empty), go vet ./... (clean), golangci-lint v2.13.2 (`0 issues.`), `go test -race ./...` (every package ok), `CGO_ENABLED=0 go build ./cmd/factory` (built).
## Learnings
- Fixture hidden tests that are `_test.go` files inside the main module break `go vet ./...`; a `go.mod` in the fixture folder fixes it.
- The local dispatcher's session key is (ticket, attempt), and ticket ids repeat across fixtures, so one dispatcher per ticket is needed.
- `just` is missing in cloud sessions; the brief's by-hand recipe list worked.
- The eval's bun and uv fixtures are untested here (uv needs network); only go-stack runs in the gate.
- One commit holds both acceptance groups, because the Diff and the runner share the fixture move.
