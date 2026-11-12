BRANCH: go/k2f-smoke
HEAD: 1b987854e58fc9f3d7ae4a49e6aa6368c17d465c
## Summary
Added `internal/smoke` (orchestration, fake agent script, opt-in live tests) and `docs/smoke.md`. The orchestration and agent script are tested end to end through the merge queue against an `httptest` GitHub and a local bare git remote. The live variant exists and is documented but was NOT run: the cloud session has no sandbox repo.
## Acceptance
- Without the env vars the test skips (unit test of the skip helper) -> TestFromEnv (8 rows), TestLive and TestLiveShadow skip with a reason -> done
- Fake agent script and orchestration unit tested against httptest GitHub plus a local bare remote, end to end through the merge queue -> TestAgentScript, TestRunMergesTheTicket (issue merged, file on base, Cleanup closes issue and deletes branches), TestRunShadowMergesNothing (no PR, no merge, no comment, 1 recorded dispatch), TestShadowQueueNeverRuns -> done
- Live variant exists and is documented; report says it was not run -> TestLive, TestLiveShadow, docs/smoke.md -> done (not run, no sandbox repo)
## API change requests
- `internal/reconcile/run.go` names the brief `<ticket>-a<n>.md`, but `internal/dispatch/local` requires `v9-<ticket>-a<n>.md` (`brief.Name`) and refuses the dispatch otherwise. Real wiring of reconcile to the local dispatcher fails on every ticket. I worked around it with a small wrapper in `internal/smoke` (the test fails without it). Fix: reconcile should call `brief.Name`.
- `wire.New` gives no way to set the gate command, and the default needs `.factory/gates.sh` in the repo. The smoke run builds `mergeq.NewCoreQueue` from the exported `wire.Git/Gate/Heads` instead. A `wire.New` option for the gate command would remove that.
- `cmd/factory`'s `shadowQueue` is unexported, so smoke carries its own copy.
## Files outside my area
none
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand with GOTOOLCHAIN=auto (the host has go1.26.0):
gofmt -l (clean), go vet ./... (clean), `GOTOOLCHAIN=go1.26.7 go run golangci-lint@v2.13.2 run ./...` -> `0 issues.`, `go test -race -count=1 ./...` -> every package ok, including `ok  github.com/KaaS-team/factory/internal/smoke 2.311s` and `internal/provenance`; `CGO_ENABLED=0 go build ./cmd/factory` -> BUILD-OK.
Mutation checks: dropping the brief-name wrapper fails TestRunMergesTheTicket (needs-human); disabling the shadow wrap fails TestRunShadowMergesNothing. shadowQueue is covered by its own test, since a shadow dispatcher never reaches the queue.
## Learnings
- The ticket's brief and the harness attribution reminder disagreed on the Claude-Session trailer; I followed the brief (Co-Authored-By only).
- `just` was missing; the brief's manual recipe list worked, but the golangci-lint download dominated the time. Preinstalling `just` and golangci-lint in the cloud image would save minutes.
- A wiring test of reconcile with the real local dispatcher would have caught the brief-name mismatch; internal/e2e uses a fake dispatcher so it cannot.
