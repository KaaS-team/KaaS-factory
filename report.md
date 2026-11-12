BRANCH: go/k7-astgrep-transform
HEAD: 0d76f201717ccd478ac72f4cae5c98c0dfcb508a
## Summary
Added a `transform` step type to the graph and a `transform` workflow (author, apply, join, verify, pr). `RunTransform` checks each rule against the vendored ast-grep schema and for valid and invalid cases, runs the rule tests, applies the rules with no model call, and lists residual hits for a follow-up ticket. It calls ast-grep through a small `AstGrep` interface with a fake in tests. Nothing in `cmd/factory` calls `RunTransform` yet (see the blocked line).
## Acceptance
- Agent writes rule YAML plus valid/invalid cases; gate checks schema (vendored rule.json) and runs `ast-grep test` -> TestRunTransform (schema violation, missing id, no tests file, no valid case, no invalid case, test fails with nothing applied) -> done
- `scan --update-all` applies to the tree, no model call -> TestRunTransform "applies and lists residue" and "test fails, nothing applied" (the interface has no model method) -> done at package level; blocked for end-to-end, see below
- Rule and snapshot land in the PR -> TestRunTransform checks `Land` (rule, tests, snapshot) -> done; `Land` is a list, and nothing stages it yet
- Residual hits listed for an agent follow-up ticket -> TestRunTransform (residual count), TestFollowUpListsResidue -> done
- Workflow wiring -> TestTransformStep, TestTransformAppliesRulesBeforeGate, TestAllPacksLoadThroughGraph -> done
- Reachable from `cmd/factory` -> blocked: no Go code runs check or transform nodes today (`internal/core/stage.go` only runs agent nodes), so `RunTransform` is unreachable. `cmd/` and `internal/core` are outside my area.
- Bite-check: I broke each behaviour once and the tests failed. Schema skipped (2 failing), `ast-grep test` skipped (5), case check removed (3), rules-key check removed (1), wrong reject edge in the yml (1).
## API change requests
- Whatever runs graph nodes (core stage runner, or a `factory transform` command) needs to call `graph.RunTransform` for `KindTransform` nodes with a real `AstGrep` from the packs session. No `internal/api` change is needed.
- The packs session's ast-grep wrapper must satisfy `graph.AstGrep` (Test, Apply, Scan) and map its parsed `scan --json` output to `graph.Hit`.
## Files outside my area
- `packs/packs_test.go`: added "transform" to `wantPacks` plus one test (otherwise the workflow count test fails).
- `go.mod`: `github.com/google/jsonschema-go` moved from indirect to direct (the ticket names a JSON-schema lib; it was already in the module graph).
- `THIRD_PARTY_NOTICES.md`: section for ast-grep@c7e005c (the embedded `rule.schema.json`).
- `internal/graph/graph.go` and `load.go`: the node wiring, which is in my area.
## Gate evidence
`just` is not installed, so I ran its recipe bodies by hand, as the brief says.
- `gofmt -l`: empty.
- `go vet ./...`: ok.
- golangci-lint v2.13.2 under go1.26.7: `0 issues.`
- `go test -race ./...`: every package `ok`, last lines `ok  github.com/KaaS-team/factory/packs`, `ok  github.com/KaaS-team/factory/pkg/agentrun`, `ok  github.com/KaaS-team/factory/pkg/sandbox`.
- `CGO_ENABLED=0 go build ./cmd/factory`: ok.
- Measures: non-test Go lines 20980 before, 21140 after (+160). Deadcode lines 74 before, 76 after; the new ones are `RunTransform`, `FollowUp` and their helpers.
## Learnings
- `just` is missing in cloud sessions; the recipe bodies run by hand, but the factory image should ship `just`.
- golangci-lint plus deadcode each need a first-time download of about two minutes; a warm module cache would save that.
- A workflow step type is only reachable once a Go runner executes non-agent nodes; that runner should land before more step types do.
- The ticket's copy table says the per-language schemas are vendored too, but `rule.json` alone is enough for the generic check; the language files add no extra check here.
