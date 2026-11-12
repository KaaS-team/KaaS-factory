BRANCH: go/mergeq-adapter
HEAD: 81260e5a9666d8b3d482fb6eaa1b859773c46308
## Summary
Added `mergeq.NewCoreQueue(Deps)` with Enqueue, Queued and Run over a `Runner`. Queue state lives in the tracker (phase merge-queue plus a `<!-- factory:queued {"pr":N,"head":"sha"} -->` comment marker), so a new CoreQueue over the same tracker lists the same entries.
## Acceptance
- Enqueue three, green gate: merged in enqueue order, tracker phases done -> TestCoreQueueGreenLandsInEnqueueOrder -> done (landed tickets end in phase `merged`, not `done`, as in internal/e2e; `done` means "PR exists" in api.Phase)
- One broken of three: two merge, culprit needs-human with log tail, main gate green -> TestCoreQueueBrokenOneIsEjectedWithLogTail -> done
- Restart lists the same entries -> TestCoreQueueRestartListsSameEntries -> done
- Enqueue of a queued ticket is a no-op -> TestCoreQueueEnqueueTwiceIsNoOp -> done
- Real local git repo, fake gate script, no network -> all of the above (bare origin in a temp dir, gate.sh) -> done
Extra: TestMarkerRoundTrip and TestCoreQueueStoreBranches cover the marker codec and the Drop/Requeue branches.
Bite proof: I broke the idempotency check and the eject phase once; TestCoreQueueEnqueueTwiceIsNoOp and TestCoreQueueBrokenOneIsEjectedWithLogTail went red, then green after the revert. The compile-failing first run was the red for the rest.
## API change requests
api.Tracker has no read of a ticket's phase or comments. mergeq defines a narrow `Tracker` with `InPhase(ctx, Phase) ([]TicketID, error)` (ordered by phase entry) and `Comments(ctx, id) ([]string, error)`. The real GitHub tracker adapter needs to implement both, or api should gain them. Also a `Heads` port (`PR(ctx, pr int) (PRState, error)`) that the wiring must provide.
## Files outside my area
none
## Gate evidence
No `just` in the image; ran recipe bodies by hand. `test -z "$(gofmt -l .)"` ok; `go vet ./...` ok; golangci-lint v2.13.2 (GOTOOLCHAIN=go1.26.7): `0 issues.`; `go test -race ./...`: every package `ok` (mergeq, e2e included); `CGO_ENABLED=0 go build ./cmd/factory` ok, binary removed. `just fast` and `just check` were not run.
## Learnings
- Local go was 1.26.0 and lint needed go1.26.7 via GOTOOLCHAIN; the factory image should ship it.
- First lint run took several minutes of module downloads; warm the module cache in the image.
- The real Git and Gate adapters exist only in test files (e2e and mine, near duplicates); a shared production adapter would save each wave rewriting them.
