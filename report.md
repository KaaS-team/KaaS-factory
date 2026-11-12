BRANCH: go/k8-lockfile
HEAD: cab8574b922d297f5b41253ffbee63cc302b3f85
## Summary
`factory.lock` is now a sorted, versioned JSON-lines file ported from dagger util/lockfile, with a commit-me header and merge-conflict detection; the v1 JSON file is still read. The patternmatcher half is blocked: no gate path rules exist in my area to replace.
## Acceptance
- Sorted, versioned file -> TestLockMarshalSortedVersionedWithHeader (bite-checked: sort reverted, test red) -> done
- Merge-conflict detection -> TestParseLockMergeConflict (bite-checked) -> done
- Header telling agents to commit it -> same header test (bite-checked: header text changed, red) -> done
- Keep reading today's format -> TestParseLockReadsLegacyJSONAndUpgradesOnWrite (bite-checked: v1 branch off, red), TestLockParseRejects, TestAddWritesGoldenLock -> done
- Unsupported version rejected -> TestParseLockUnsupportedVersion -> done
- Gate path allow/deny with Dockerignore-style globs incl. negation via moby/patternmatcher -> blocked: internal/gate has no path rules (only a secret regex) and protected_paths lives in internal/config, both outside my area. Adding the dependency with no caller would be unreachable from cmd/factory, so I did not add it.
## API change requests
None. A later ticket owning internal/gate or internal/config should import github.com/moby/patternmatcher (v0.6.1, Apache-2.0) and match `protected_paths` with it.
## Files outside my area
- internal/upgrade/testdata/apply.lock.golden: regenerated, it pins the lock bytes written by packs.WriteLock.
- THIRD_PARTY_NOTICES.md: new dagger/dagger@835b0ef section, required by the provenance test.
## Gate evidence
`just` is not installed; ran the recipe bodies by hand: gofmt -l . (empty), go vet ./... (clean), golangci-lint v2.13.2 with go1.26.7 ("0 issues."), go test -race ./... (all ok), CGO_ENABLED=0 go build ./cmd/factory (ok).
Measures: non-test Go lines 21276 before, 21389 after (+113; the new format and v1 reader are larger than the old JSON code). Deadcode not run (time); nothing new is unreachable, since Marshal, ParseLock, ReadLock and WriteLock are all used by the packs and upgrade commands.
## Learnings
- Running the whole gate by hand without `just` takes over 10 minutes because golangci-lint compiles; the brief should say to start it in the background first.
- A ticket that names a package for a dependency should name its caller; there was nothing to wire patternmatcher into.
- The lock golden in internal/upgrade is a hidden second consumer of the lock format.
