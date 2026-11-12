BRANCH: go/plan
HEAD: 1a1eca42264c8bf10e88444d0d7802ba80ca76d5
## Summary
Added `internal/plan` (lossless planned body v1 parse and render, ticket DAG, `Problems()`, `Waves()`) and `internal/plan/intent` (goal to spec to tickets behind a `Drafter` interface, rejecting drafts with problems).
## Acceptance
- Planned body round trip -> TestBodyRoundTripsTSFixtures (planned-issue.md, a pick-test body, a groom stub body; the pick and groom bodies are copied by hand from inline strings in tests/) -> done
- DAG wording for cycle, duplicate, unknown dependency -> TestProblems (table) -> done. problems.ts is config validation and has no DAG wording, so the wording comes from src/intent/tickets.ts and src/engine/import-plan.ts
- Waves -> TestWaves, TestWavesRefusesBrokenGraph -> done
- Intent: missing Files rejected, valid draft parses as planned v1 -> TestRunRejects, TestRunAcceptsValidDraft -> done
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt -l, go vet ./..., golangci-lint v2.13.2 via go run (0 issues), go test -race ./..., CGO_ENABLED=0 go build ./cmd/factory.
ok  github.com/KaaS-team/factory/internal/plan/intent
ok  github.com/KaaS-team/factory/internal/provenance
GATE-OK
## Learnings
- The brief names problems.ts for DAG wording, but it holds config checks; point briefs at tickets.ts and import-plan.ts.
- just is missing in cloud sessions; install it in the environment.
- A "byte compatible" parse is simplest as a lossless section split with typed views on top.
