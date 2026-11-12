BRANCH: go/k2f-browsercheck
HEAD: 7d1de0fdbb1c979037063829594fcd71a0d3ecca
## Summary
Added `internal/browsercheck` (YAML step parser, chromedp runner, FACTORY_GATES line) and `packs/checks/browser/pack.yaml`. Pinned chromedp v0.23.0 (newest stable from `go list -m -versions`), MIT at that version; cdproto v0.159.0 is MIT and go-json-experiment is BSD.
## Acceptance
- Step YAML parser table (unknown step, missing selector, bad URL) -> TestParseSteps -> done
- httptest page: pass, missing text fails, console error fails, line parses with gate.Parse -> TestRunAgainstPage (ran against real Chrome here, not skipped) -> done
- No Chrome gives a fail with "browser: chrome not found" (fake lookup) -> TestRunNoChrome -> done
## API change requests
None to internal/api. The pack's `command` is `factory browsercheck --steps ... --out ...`, but no such subcommand exists, because cmd/ is outside my area. Please add a cobra command that calls `browsercheck.ParseSteps`, `browsercheck.Run` and prints `Result.Line()`. The pack.yaml shape is my own (no pack.yaml existed in the repo; ast-grep-residue is a bare check.sh), covered only by TestPackDeclaresCheck.
## Files outside my area
go.mod, go.sum (chromedp dependency, as the ticket allows).
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand. gofmt -l . printed nothing. go vet ./... printed nothing. golangci-lint v2.13.2 on ./internal/browsercheck/...: "0 issues." (not run on the whole repo). go test -race ./... printed no failures. CGO_ENABLED=0 go build ./cmd/factory built.
## Learnings
- chromedp v0.23.0 has a new generic API (Do/Run, Listen, CSS(sel)); the old docs and examples do not compile. Read docs/API.md in the module.
- I wrote the parser and its test together and did not watch the parser test fail first. For the runner, the test failed to compile before the code.
- The full golangci-lint run exceeds the 120s tool limit on first run (module downloads); the factory defaults should warm the cache.
