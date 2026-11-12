BRANCH: go/k7-cachevol
HEAD: 321ed6e99fe5d804e44797548863a01ac666b295
## Summary
Ported dagger engine/cachevolumedir (Apache-2.0, 835b0ef) to `pkg/sandbox/cachevol` with a tenant field, no test hooks, notice added. It is not wired into `cmd/factory`, so deadcode rose from 70 to 100.
## Acceptance
- volumes keyed by digest including tenant -> TestIdentityIDIncludesTenant, TestAcquireCreatesOnceAndFailedPopulateLeavesNothing -> done
- flock single owner -> TestOpenSingleOwner -> done
- Collect honours max-used and min-free with LRU, never removes pinned -> TestCollectPolicy, TestPolicyTargetBytes -> done
- kill -9 leaves a consistent directory -> TestKillNineLeavesConsistentDirectory, TestDirtyVolumeIsRemeasuredAfterKill -> done
- NOTICE and licence retained -> `## dagger/dagger@835b0ef` in THIRD_PARTY_NOTICES.md (internal/provenance test passes) -> done
- Wire Policy to our host budget -> blocked (no host budget type in this area; Policy takes byte values, and the filesystem free-space reading is left to the caller)
- One registration line / reachable from cmd/factory -> blocked (needs a call from cmd/ or internal/dispatch, outside my area)
Bite-checks: reverted each fix once and watched its test go red: tenant in ID, flock mode, pin check in remove, LRU order, max-used test, min-free test, tmp/trash sweep on Open, dirty marker on writable pin (first mutation survived; test fixed, then it failed as it should).
## API change requests
None.
## Files outside my area
- go.mod: golang.org/x/sys moved from indirect to direct (store.go imports it).
- THIRD_PARTY_NOTICES.md: required by the provenance test.
## Gate evidence
`just` is missing; ran the recipe bodies by hand. gofmt -l: empty. go vet ./...: clean. golangci-lint v2.13.2 (go1.26.7): `0 issues.` go test -race ./...: all ok. CGO_ENABLED=0 go build ./cmd/factory: built.
Measures: non-test Go lines (outside src/) 20980 before, 21922 after. Deadcode lines 70 before, 100 after (the whole store is unreachable until something calls it).
## Learnings
- The brief's 20357 line count did not match next (20980); state the baseline command output, not a number.
- Reachability and "one registration line" conflict with a no-cmd-edits rule; the brief should name the caller.
- golangci errcheck flags every ported Close/Remove; budget for `_ =` edits.
