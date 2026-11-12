BRANCH: go/plan-cmd
HEAD: d94fb3269420603e674893bf42f072651db714d4
## Summary
Added `internal/plancmd`: `plan` command with `--spec`, `--epic`, `--approve`, `--json`, built on `internal/plan/intent`. The model step is an injected `SpecFunc`; the default errors and says to pass `--spec`.
## Acceptance
- Five-ticket spec fixture prints expected waves -> TestPlanPrintsWavesGolden -> done
- Cycle or duplicate listed, `--approve` refuses -> TestPlanProblemsListedAndApproveRefuses -> done
- `--approve` files each ticket once with `Files:` and `Blocked by:`; second run files nothing -> TestApproveFilesOnceIdempotent -> done
- `--json` decodes into the DAG type -> TestJSONDecodesIntoDAG -> done
## API change requests
`api.Tracker` has no way to create a ticket or find one by title. plancmd defines `Filer{Find(ctx,title); Create(ctx, api.Ticket)}`. The supervisor needs a tracker that implements it (GitHub: search issues by title, create issue). `--epic` needs an `EpicFunc` (read issue body); not wired by the supervisor yet.
## Files outside my area
none
## Gate evidence
`just` is missing, so I ran its recipe bodies by hand (also gofmt gated with `test -z "$(gofmt -l .)"`): gofmt, go vet, golangci-lint v2.13.2 ("0 issues."), `go test -race ./...` (all ok, last line `ok github.com/KaaS-team/factory/packs`), `CGO_ENABLED=0 go build ./cmd/factory` ok, binary removed. go.mod untouched. `just fast` was not run for the same reason.
## Learnings
- The spec/ticket file format (`--- ticket <key>: <title>` blocks after the spec) is my own choice; intent.Drafter.Tickets needs a model, so with `--spec` the tickets are read from the file. Confirm or replace when the runner is wired.
- Tests passed first time for the golden and JSON rows; I proved the idempotence and refuse-on-problems tests bite by breaking the code (4 and 2 failing tests), then reverted.
- A fixture named cycle.md matched the word "cycle" through its slug error and masked the test; renamed to loop.md. Name fixtures neutrally.
- Lint cost one background run (~2 min) for errcheck on fmt.Fprint; use a `say` helper from the start.
