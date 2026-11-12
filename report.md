TICKET: m3-packs-lock
NEXT: 5738633aea417ced50b47886db12540e13a6be86
## Fixed
- `factory packs run` refuses a pack not pinned in factory.lock (by cache path or sha256), refuses a locked pack whose hash differs, runs a locked matching pack; `--unlocked` runs anything with one stderr warning, no env bypass -> 5738633, TestRunRefusesPackNotInLock, TestRunRefusesLockedPackWithChangedHash, TestRunRunsLockedMatchingPack, TestRunUnlockedFlagWarnsOnce
## Bite checks
- TestRunRefusesPackNotInLock (lock check disabled) -> manifest_command_test.go:133: err = <nil>, want one naming the pack and the lock
- TestRunRefusesLockedPackWithChangedHash (entry hash not passed to LoadManifest) -> manifest_command_test.go:146: err = <nil>, want hash mismatch
- TestRunUnlockedFlagWarnsOnce (warning removed) -> manifest_command_test.go:165: err = <nil> out = ""
- TestRunRunsLockedMatchingPack is the positive case (fails if the lock check wrongly refuses).
## Other callers
- internal/packs/manifest_command.go (match): safe, only parses manifests and prints names, never runs a check; one-line comment added.
- internal/packs/command.go (verify): passes the lock entry hash already.
- manifest_test.go: tests only.
## Gate evidence
(`just` is not installed; the check recipe was run by hand: gofmt, vet, race tests incl. -tags ee, build, ratchet, golangci-lint v2.13.2)
vet-ok
tests-done
build-ok
go_lines 30675 (baseline 30680), deadcode 233 (baseline 233)
0 issues.
Also: go test -race -count=3 ./internal/packs/... ./cmd/factory/... ok.
## Scope notes
- Added `--root` to `packs run` (needed to find factory.lock); docs/cli-reference.md regenerated, so the run section moved after migrate (generator order).
- .ratchet.json raised by 50 lines across three concurrent-push conflicts.
- Left out: no refactor, no other docs. Untracked internal/a2a/a2a-audit.jsonl (test artifact) not committed.
## Learnings
- Go 1.24 default; needed GOTOOLCHAIN=auto.
- `just` missing; recipe run by hand, lint takes minutes.
- Concurrent pushes conflict on .ratchet.json every time; rebase, take larger, push immediately, gate after.
