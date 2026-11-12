BRANCH: go/k7-sarif
HEAD: fb6f440a24864b4669ea7055ae28c1fb6830e137
## Summary
First-run reads a reason-tagged annotations file (`--annotations`, default `.factory/annotations.yml`, optional) and writes SARIF 2.1.0 (`--sarif <path>`). A suppressed finding leaves the rows and top risks and counts as satisfied in the score; it shows in the report's "Suppressed" section and in SARIF as a suppression with its reason.
## Acceptance
- A reason-tagged suppression removes a finding from the score and appears in the report with its reason -> TestSuppressionLeavesScoreAndShowsReason, TestCommandFlags, TestParseAnnotations, TestConfigReason -> done
- SARIF validates against schema -> TestSARIFValidatesAgainstSchema (vendored official SARIF 2.1.0 schema, draft-04 rewritten to draft-07 for the validator; a negative case proves it can reject), TestSARIFResults, TestSARIFOfReport -> done
- Bite-check: reverted once each: annotate call, score credit, SARIF suppression, SARIF tool.driver, explicit-missing-file error. Each turned its test red; restored green.
- Left out: scorecard's Finding/Outcome, aggregate, workflow rules (tickets 1 and 2, other sessions). Scorecard's fixed check-name list is replaced by "check id is not blank" because we have no list of auditor ids here. Only the first reason of an annotation is used. SARIF `version` is empty from the CLI (no version is passed in).
## API change requests
none
## Files outside my area
- `go.mod`: `github.com/google/jsonschema-go` moved from indirect to direct (the SARIF schema test uses it; `go mod tidy`).
- `docs/cli-reference.md`: regenerated (`UPDATE_GOLDEN=1`), because `TestCLIReferenceFresh` fails on the two new flags.
- `THIRD_PARTY_NOTICES.md`: new ossf/scorecard section (required by the provenance test).
- `internal/firstrun/{command.go,firstrun.go}`: the hook itself (first-run command, which the brief names).
## Gate evidence
`just` is missing; ran its recipes by hand: gofmt -l (empty), go vet, golangci-lint v2.13.2 (`0 issues.`), `go test -race ./...` (no failures), `CGO_ENABLED=0 go build ./cmd/factory` (`BUILD_OK`). After the last edit (deleting an unused `Suppress`) I re-ran gofmt, vet, lint and race tests on firstrun, provenance and cmd only, not the whole tree.
Measures: non-test Go lines (excluding `src/`) 20980 -> 21313 (+333; counted from `origin/next` via git ls-tree, since `git ls-files` run inside a subdirectory gave 489). Deadcode lines 70 -> 70 (an intermediate version had 75 until the unused `Suppress` was removed; the 70 includes the existing `WithExec`).
## Learnings
- `just` is absent in cloud sessions; the brief's by-hand recipe works but takes over 2 minutes, so it needs a background run.
- The line-count command in the brief depends on cwd; it should say to run it at the repo root.
- Adding a CLI flag fails the generated CLI doc test; the brief should list `docs/cli-reference.md` as an expected edit.
