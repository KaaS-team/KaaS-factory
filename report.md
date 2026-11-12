BRANCH: go/k4-stall-steer
HEAD: c81f886e9a135e7eacd18525b70e13a8296325ea
## Summary
Reconcile now names briefs with `brief.Name` (so the `v9-` prefix every dispatcher checks is used, and a bad ticket id becomes a dispatch failure). The stall steer/retry/needs-human path already existed and passed; I added the missing boundary rows and a no-session-leak check.
## Acceptance
- run.go uses brief.Name; test pins the name -> TestDispatchBriefNameIsBriefName (saw it fail with "a-a1.md", pass after) -> done
- Stall: one steer, retry at 2x with 8.4 backoff, needs-human after budget, session URL operator-only -> TestDecide (new rows: just under, exactly stall_after, just under 2x, exactly 2x, capped backoff, older-attempt push ignored, same-attempt push resets), TestTickStallRetryNeedsHuman (now asserts the tracker comment has no session id or URL) -> done. The behaviour was already implemented, so the new rows passed on first run; no code change was needed.
- Delete what core no longer calls -> blocked/none found: deadcode reports nothing in internal/reconcile. `recoverState` and `Deps.InitialLocks` duplicate core.recover and are unused by core in the normal path, but conformance and e2e tests (outside my area) call Tick with a nil state, so deleting them needs edits there.
## Measures
- Non-test Go lines: 20357 before, 20362 after (+5, the error path for brief.Name).
- Deadcode lines: 68 before, 68 after.
## API change requests
none
## Files outside my area
none. Note: `internal/core/control.go:60` and `internal/core/stage.go:73` still build `Name` with `fmt.Sprintf("%s-a%d.md")` and would be refused by every real dispatcher; they should call `brief.Name` too.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt clean, go vet clean, golangci-lint "0 issues.", `go test -race ./...` all ok (no failures), `CGO_ENABLED=0 go build ./cmd/factory` ok.
## Learnings
- `just` missing in the cloud image; the factory default should install it or the brief should say to run the recipes.
- Two acceptance lines described work that already existed; the brief should be checked against the tree before it is issued.
