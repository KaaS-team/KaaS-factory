BRANCH: go/k6-checkpoint
HEAD: cda2334429ab9e47f7938d992cf7cc1266b80e2e
## Summary
Added `internal/gitx/checkpoint`: Snapshot, Restore, Diff, Delete and a 14 day Reap, ported from cline checkpoint-hooks and checkpoint-restore to Go over os/exec, with a notice section in `THIRD_PARTY_NOTICES.md`. `just` was missing here, so I ran its recipes by hand. The package is not yet reachable from `cmd/factory` (see API change requests).
## Acceptance
- Snapshot captures tracked, staged and untracked files without touching the user's index or `refs/stash` -> TestDirtyTreeRoundTrip (compares `ls-files -s`, stash list, HEAD and status before and after), TestUntrackedOnly, TestNestedRepoKeptInSnapshot, TestStaleUntrackedDropped -> done
- Restore returns a dirty tree byte for byte; clean tree, untracked only, `core.ignorestat=true` -> TestCleanTreeRoundTrip, TestDirtyTreeRoundTrip, TestUntrackedOnly, TestIgnoreStat -> done
- Refs and scratch dirs deleted on session end, 14 day reaper -> TestDeleteRemovesRefsAndScratch, TestReapAfterFourteenDays (13 days kept, 15 days removed, dir and ref asserted separately) -> done
- Extra, from the port: restore refuses when HEAD moved -> TestRestoreRefusesMovedHead; Diff -> TestDiff; session id validation -> TestSessionIDValidation
- Bite-check: each fix reverted once and its test went red: ignorestat pin (TestIgnoreStat), stale-entry drop (TestStaleUntrackedDropped), HEAD guard (TestRestoreRefusesMovedHead), clean -fd (5 round-trip tests), nested-repo normalization (TestNestedRepoKeptInSnapshot), ref delete and scratch delete (TestDeleteRemovesRefsAndScratch), reap age for dirs and refs (TestReapAfterFourteenDays), `stash apply --index` (TestDirtyTreeRoundTrip).
- Left out: tickets 2 and 3 (other sessions); the other copy-list files (command-guard, mode.ts, tool-policies.ts) belong to them. Symphony spec sections: none apply to this package.
## API change requests
- None to `internal/api`. Wiring is needed from `cmd/factory` or the core: build `checkpoint.New(repo, scratchBase, sessionID)` before an agent run, `Snapshot` before it, `Restore` on a failed or rejected run, `Delete` on session end, and `Reap` at startup. I did not edit `cmd/`, so `deadcode` lists the new exports as unreachable.
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: added the `cline/cline@50e77bc...` section the provenance test requires.
## Measures
- Non-test Go lines (the given command, including untracked files): 20357 before, 20695 after (+338; the file has about 90 lines of comments). Not under the 8000 budget, and I added to it; the ticket asked for an addition.
- Deadcode lines: 68 before, 86 after (+18, all the new exports, until something calls them).
## Gate evidence
Run by hand because `just` is not installed (gofmt -l, go vet ./..., golangci-lint v2.13.2 under go1.26.7, go test -race ./..., CGO_ENABLED=0 go build ./cmd/factory):
gofmt: no output
golangci-lint: 0 issues.
go test -race ./...: no failures
CGO_ENABLED=0 go build ./cmd/factory: BUILD_OK
## Learnings
- `just` was absent; the brief's manual recipe list worked, but the full race run takes over 2 minutes, so start it in the background at once.
- `internal/gitx` keeps its runner unexported, so a sub-package must write its own env and stdin runner; an exported option would avoid the copy.
- The provenance test needs one notice section per `repo@sha`, so a two-file port needs two header lines that name the same sha.
- A ref's creation date is not available in git; a fresh commit per checkpoint (even for a clean tree) is what lets the reaper date refs.
