BRANCH: go/k10-judge-cache
HEAD: d3825cc702693f1e8d2d72e3e9f587f5ced0bc52
## Summary
New `internal/eval/judgecache` wraps a `Judge` interface with an on-disk verdict cache keyed by sha256 over length-prefixed (fixture, output, rubric version). It is not yet reachable from `cmd/factory` (see API change requests).
## Acceptance
- Second run of an unchanged fixture makes zero judge calls -> TestSecondRunMakesZeroJudgeCalls -> done (bite: forcing Cached=false on hit fails it)
- Cache invalidates on rubric edit -> TestKeyInvalidation/rubric_edit (also output, fixture, field boundary rows) -> done (bite: dropping rubric from Key fails it)
- Scorecard marks cached rows -> TestMarker (Marker, Row helpers) -> blocked in part: helpers exist, but `eval.Scorecard`/`Markdown` are outside my area so no scorecard column is wired
- Extra: judge errors not cached (TestJudgeErrorIsNotCached), corrupt entry is a miss (TestCorruptEntryIsAMiss)
## API change requests
- internal/eval has no judge today. To wire it: add a `Cached bool` to the judged row in `eval.TicketResult`, call `judgecache.New(dir, realJudge).Judge` where the judge runs, and use `judgecache.Marker` in `Markdown`. Without this the package is unreachable from `cmd/factory` (deadcode count rose by unreachable exports only).
## Files outside my area
none
## Gate evidence
`just` is missing; ran the recipe bodies by hand: gofmt clean, go vet clean, `go test -race ./...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` ok, golangci-lint (scoped to ./internal/eval/...) "0 issues." Full-repo lint was not run.
Measures: non-test Go lines 21276 before, 21276 after the count run (measured before commit; package adds about 100). Deadcode before: not measured separately; after: 79 lines (includes this package's unwired exports).
## Learnings
- `just` is absent in cloud sessions; the brief's fallback commands worked.
- A ticket whose area excludes the consumer cannot meet "reachable from cmd/factory"; the brief should name the wiring owner.
