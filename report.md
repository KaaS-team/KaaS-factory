BRANCH: go/gate-observe-store
HEAD: 019e107be84c9337e0557969b5978925e5c5154f
## Summary
Added `internal/gate` (process-group runner, FACTORY_GATES parser), `internal/observe` (Observer over a narrow Source, plus PhaseOf) and `internal/store` (pure Go sqlite cache with Rebuild). The race tests, vet, lint and the static build are green.
## Acceptance
- Gate parse: TS fixture lines give the same result as src/gates.ts -> gate.TestParse -> done
- Gate run: a sleeping command is killed with its children and reported as a timeout fail -> gate.TestRunTimeoutKillsProcessGroup (also TestRunMissingLineIsFail, TestRunGreenAndRed, TestRunTailBound) -> done
- Observe: one row per phase outcome -> observe.TestObserve -> done
- Store: delete the database, Rebuild from fakes, rows equal -> store.TestRebuildMatchesLive -> done
- CGO_ENABLED=0 go build passes with sqlite -> `CGO_ENABLED=0 go build ./cmd/factory` -> done (not imported by cmd yet, but the packages build with it under go vet and go test)
## API change requests
- `api.Tracker` has only `Ready`, so Rebuild from an empty file cannot see running or done tickets. Add `Active(ctx) ([]Ticket, error)` to Tracker, or a separate Lister port. `store.Lister` is that interface; Rebuild uses it when the tracker implements it and falls back to `Ready`.
- Rebuild cannot restore session id, URL or dispatcher, or phases a human set through the tracker (needs-human, canceled). Session rows hold only what git shows.
## Files outside my area
- go.mod, go.sum: modernc.org/sqlite (named by the ticket) and its indirect requirements.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt -l (clean), go vet ./... (clean), golangci-lint v2.13.2 via go run (`0 issues.`), go test -race ./... (all ok, including provenance), CGO_ENABLED=0 go build -o dist/factory ./cmd/factory (BUILD_OK).
## Learnings
- `just` is missing in cloud sessions; the factory image should install it.
- golangci-lint v2.13.2 needs Go 1.26, so `GOTOOLCHAIN=auto` is required for lint, not only for the 1.25 build.
- The session-attribution reminder asks for a `Claude-Session:` trailer that the brief forbids; I left it out.
- The `ListAgents`-style pipe `git fetch` prints about 100 new refs; add `-q`.
