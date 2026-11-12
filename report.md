BRANCH: go/k4-mergetree
HEAD: 2b5155573d02f869751401323c73090423d43b3d
## Summary
Refill now skips an area-overlapping ticket unless both tickets have branches and `Locks.Merge` (bound to `gitx.MergeTree`) reports a clean merge, and returns one skip reason per passed-over ticket; Decide emits it as a `skip` action. gitx lost `NewLeaseCommit`, `PushLease` and `EmptyTree`, which nothing reached.
## Acceptance
- Refill skips overlapping ticket, and with both branches, on a merge-tree conflict (real temp repo, two branches) -> TestRefillMergeTree (rows: conflict skips, clean merge starts, missing branch, no Merge, merge error) -> done in pick. Not wired: nothing in `cmd/` or reconcile fills `Locks.Branches` or `Locks.Merge` yet (see requests). Reverting the conflict case made the conflict row fail.
- Skip reason visible in decision output, one line per skipped ticket -> TestRefillSkipReasons, reconcile TestDecide "retry holds its files" -> done (`Kind: skip` action with Reason; apply ignores it)
- gitx keeps only reached functions -> removed NewLeaseCommit, PushLease, EmptyTree and their tests; `MergeTree` and `DiffNames` are reached only by tests until the Merge wiring lands -> partial
## API change requests
- Something in `cmd/factory` or reconcile must set `State.Locks.Branches` (factory/<id>-a<attempt>) and `Locks.Merge = func(a,b) { return git.MergeTree(ctx, "main", a, b) }`. Until then MergeTree is unreachable from cmd and the overlap rule behaves as before.
- Consider a `Branch` field on `api.Ticket` or `Entry`.
## Files outside my area
- internal/reconcile/decide.go: new `Skip` Kind, emit skips from Refill (minimal; Refill's signature changed).
- internal/reconcile/decide_test.go: one row now expects the skip action.
## Gate evidence
`just` is not installed; ran the recipe bodies by hand with GOTOOLCHAIN=go1.26.7: gofmt clean, go vet, golangci-lint v2.13.2, `go test -race ./...` all ok (last lines: `ok github.com/KaaS-team/factory/pkg/agentrun`, `ok github.com/KaaS-team/factory/pkg/sandbox`), `CGO_ENABLED=0 go build ./cmd/factory` ok.
Measures: non-test Go lines 20357 -> 20381 (+24, Skip plumbing and merge check outweigh the deleted lease helpers). Deadcode 68 -> 68 lines, none in gitx or pick.
## Learnings
- `go run deadcode` prints download lines on first run, inflating the count; use `2>/dev/null`.
- The ticket says "when both have branches" but `api.Ticket` has no branch; the brief should name where branches come from.
