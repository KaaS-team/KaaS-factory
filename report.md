BRANCH: go/k4-core-dispatch
HEAD: 110522d55093c96fce38e65aafd3984b513efa98
## Summary
The core now names every brief with `brief.Name`, so `Core.Dispatch` and `Core.Tick` start a real local session; `nameFixer` is gone. A ticket that reaches a human node in its workflow parks, and a trusted `/factory approve` or `/factory revise` moves it on.
## Acceptance
- core builds brief names with brief.Name; real local dispatcher test; revert goes red -> TestDispatchStartsRealLocalSession, TestTickStartsRealLocalSession (both failed before the fix and fail again with it reverted) -> done
- nameFixer deleted, smoke passes through real names -> TestRunMergesTheTicket, TestRunShadowMergesNothing -> done
- approve and revise act in the loop, untrusted change nothing, table test through core.Tick -> TestApproveAndReviseThroughTick (5 rows), TestApproveWithoutWaitingTicketIsIgnored (the approve row goes red with the call removed) -> done
- smoke tests that only assert on their own fakes deleted -> TestAgentScript deleted (the loop test covers the script through the real dispatcher); TestShadowQueueNeverRuns kept, it tests the real shadowQueue -> done
## Measures
- Non-test Go lines: 20357 before, 20398 after (+41, nearly all the approve/revise wiring).
- Deadcode lines: 68 before, 67 after.
## API change requests
- A `PhaseAwaitingApproval` in `internal/api`. A parked ticket is set to needs-human today, so the tracker cannot show `factory:awaiting-approval` for it.
## Files outside my area
- `internal/observe/commands.go`: added VerbApprove, VerbRevise and `Command.Text`, because the Commander port carried only retry and cancel.
- `internal/tracker/github/thread.go`: `Commands` returns approve and revise (two cases). Trust filtering is the existing `Trust.Command`.
## Not done
- A human node's `after` auto-approve window is not acted on. Only an explicit command resumes a parked ticket.
- `internal/reconcile/run.go:260` keeps the old name; core overwrites it in `loopDispatcher.Dispatch`. The stall-steer session owns that file.
- Parked state is in memory: after a restart a ticket waiting on approval is not recovered from the thread.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: `gofmt -l .` (empty), `go vet ./...` (clean), golangci-lint v2.13.2 (`0 issues.`), `go test -race ./...` (all ok, no failures), `CGO_ENABLED=0 go build ./cmd/factory` (built).
## Learnings
- `just` missing in the cloud image: the factory image should ship it.
- The core had no stage test at all, so a human node would have been dispatched as an agent; a stage test belongs next to every graph feature.
- porttest.Dispatcher keeps no briefs, so tests wrap it to see them.
