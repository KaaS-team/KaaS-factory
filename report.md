BRANCH: go/k4-firstrun-pr
HEAD: 048a6392f705b1558c4d12ce51241b8d89a2574b
## Summary
`firstrun.Execute` dispatches one brief for the picked finding, opens one draft PR through a narrow `PROpener`, and returns a scorecard (estimate and actual side by side, unmeasured reads "not measured"). `--dry-run` now names the first fix and says what it would dispatch. Not wired in `cmd/factory`: `WithExec` is unreachable until cmd passes it (see API change requests).
## Acceptance
- picks the right finding, one brief, one draft PR, body has no token count, cost or model -> TestPickTable, TestExecuteDispatchesOneBriefAndOpensOneDraftPR, TestExecuteBriefAsksForFreshSessionVerify, TestExecuteDispatchErrorOpensNoPR, TestExecuteNothingCoveredDispatchesNothing -> done (the "fresh session" verify is a line in the brief; no separate verify dispatch)
- scorecard JSON, estimate and actual side by side, missing actual is "not measured" -> TestScorecardMissingActualIsNotMeasured -> done (gates and human touches are "not measured" unless an Observer gives gates)
- `--dry-run` dispatches nothing and says what it would do -> TestExecuteDryRunDispatchesNothingAndSaysWhat, TestDryRunDispatchesNothing, TestCommandPrintsReport -> done
## Measures
- Non-test Go lines: 20357 before, 20511 after (+154 counting the new untracked files; 20384 tracked at the first count).
- Deadcode: 68 before, 69 after (the one added is `WithExec`, unreachable from cmd/factory until wired).
- Not met: "nothing you add may be unreachable from cmd/factory" and "prefer deleting". I deleted nothing.
## API change requests
- cmd/factory: call `firstrun.NewCommand(firstrun.WithExec(Exec{Dispatcher, PRs, Observer, Repo, Base}))` and provide a `PROpener` over the GitHub tracker. The tracker's `OpenPR` takes a ticket id and reads the thread, so it does not fit a first-run branch with no issue; a direct draft-PR call is needed.
- internal/api: a PR-opening port that does not need a ticket thread.
## Files outside my area
- docs/cli-reference.md: regenerated (`UPDATE_GOLDEN=1 go test ./cmd/factory`) because the `--dry-run` flag text changed.
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt -l clean, go vet ./... clean, golangci-lint v2.13.2 on ./internal/firstrun/... "0 issues." (not the whole tree), `go test -race ./...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` built. `just check` itself was not run.
## Learnings
- `just` is not installed in cloud sessions; the factory image should ship it.
- Running full-tree lint and race tests takes over two minutes and hits the foreground timeout; run in the background.
- A flag help string is pinned by docs/cli-reference.md, so a one-word flag change reaches a file outside the package.
- I did not run a revert-the-fix check by hand; the tests failed on compile before the code existed, which is the only failing run I saw.
