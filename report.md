BRANCH: go/pipeline-packs
HEAD: bec8131678cfecfb791a7097c35b78cb2c4357c6
## Summary
Seven workflow packs in `packs/workflows/` load through `internal/graph`, and `packs/packs_test.go` walks them for all four acceptance lines. `just` is missing here, so the gate recipes were run by hand.
## Acceptance
- All seven load through internal/graph -> TestSevenPacksLoadThroughGraph -> done
- Every build node has a later fresh-session verify -> TestBuildIsFollowedByFreshVerify -> done
- Every named skill exists or is in the pins list -> TestEverySkillExists -> done (pins list is empty; real blueprint list not visible)
- No model names -> TestNoModelNames -> done
- Also: TestEveryNodeNamesTierAndBudget, TestFanoutPacksJoinBeforeGate, TestCoverageRampLoopsOnCheck
## API change requests
internal/graph: add `tier`, `budget` and `skills` step keys. The loader refuses unknown step keys, so packs carry them in a top-level `agents:` map keyed by node id.
internal/graph: fanout branches are static, so migration and framework-upgrade use three fixed lanes, not one per module.
## Files outside my area
none
## Gate evidence
gofmt clean, go vet clean, go test -race ./... all ok (including packs), golangci-lint v2.13.2: "0 issues.", CGO_ENABLED=0 go build: BUILD_OK. `just` not installed; recipes run by hand.
## Learnings
- `just` is absent in cloud sessions; install it in the environment.
- golangci-lint via go run takes over 2 minutes cold; a cached binary would help.
- The graph loader has no field for tier or budget, so a brief that requires them needs a loader change first.
