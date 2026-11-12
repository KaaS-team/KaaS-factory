BRANCH: go/k11-graph-interrupt
HEAD: c093cb056625231416c5256f5b8a53906d6c05dc
## Summary
New `internal/graph/interrupt` package ports langgraph's interrupt semantics (payload, response schema, stable id, Resume, order matching, idempotent effects) over SQLite. The human node in core now stores each plan approval as an interrupt and checks the answer against a schema before resuming.
## Acceptance
- Interrupt result with payload, optional schema, stable id -> TestInterruptReturnsPendingWithStableID -> done
- Approval survives restart -> TestApprovalSurvivesRestart (reopens the DB), TestPlanApprovalIsADurableInterrupt (core) -> done
- Resume value validated against schema -> TestResumeValidatesAgainstSchema (6 rows incl. rejected value stays pending) -> done
- Multiple interrupts in one task matched by order -> TestMultipleInterruptsMatchedByOrder, TestParallelInterruptsAnsweredOldestFirst -> done
- Side effects after interrupt idempotent -> TestOnceRunsSideEffectOnceAcrossReplays (replay across restart), TestOnceRetriesAfterFailure -> done. Limit: a crash between the effect and its mark runs it once more; fn receives a thread-scoped idempotency key for that case.
- Bite checks done: validation off (fails), oldest-first order reversed (fails), effect mark removed (fails), core answer() removed (fails), core raise() removed (fails). The id-per-index mutation was not cleanly applied; that property is asserted by `p.ID == first` in the order test but I did not see it fail.
- "from gate": the kaasbot/gate side is not in this repo, so only the factory human node is hooked. Shapes follow the ticket.
## Found already there
Nothing for interrupts. The human node (`graph.KindHuman`, `core.resume`, `/factory approve|revise`) existed in memory only; I kept it and added the durable layer.
## Measures
- Non-test Go lines: 21418 before, 21665 after (+247; no deletions were possible, the area is new).
- Deadcode lines: 70 before, 70 after (Open was unreachable until the store hook below).
## API change requests
none. cmd/ needs no change: core.New takes the Book from a Store that has `Interrupts()`, and `*store.Store` now does.
## Files outside my area
- internal/core/core.go, stage.go (the human-node hook; optional `Deps.Interrupts`, nil keeps old behaviour)
- internal/core/approve_test.go (parkedRig now delegates to parkedRigWith so a test can pass a Book)
- internal/store/store.go (one method, `Interrupts()`, so the package is reachable from cmd/factory without editing cmd/)
- go.mod (jsonschema-go v0.4.3 moved from indirect to direct; already in the module graph, MIT), THIRD_PARTY_NOTICES.md (langgraph section)
## Gate evidence
`just` is not installed; ran the recipe bodies by hand: `gofmt -l .` (empty), `go vet ./...` (clean), golangci-lint v2.13.2 under go1.26.7 ("0 issues."), `go test -race ./...` (all ok), `CGO_ENABLED=0 go build ./cmd/factory` (BUILD_OK).
## Learnings
- `just` missing in the cloud image; the brief's fallback worked, but the image should ship it.
- Stage state (`c.stages`) is in memory, so after a daemon restart a parked ticket's interrupt survives but the graph position does not; a restart-safe resume needs the graph module's checkpoint ticket (#1).
- Brief should say whether a test-only mutation counts as a bite when the first sed does not apply; two of mine silently matched nothing.
