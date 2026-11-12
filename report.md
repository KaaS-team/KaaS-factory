BRANCH: go/plan-filer
HEAD: aaf0fc8064f19bd4918d589b498d619cd4e87e7c
## Summary
`*github.Tracker` now has `Find` and `Create` (satisfying `plancmd.Filer`) and `github.Epic(tr)` returns a `plancmd.EpicFunc`. Create is idempotent by title, and the planned body is posted as given.
## Acceptance
- `*github.Tracker` satisfies `plancmd.Filer` -> compile-time assertion in filer_test.go and filer.go -> done
- Create posts body byte for byte equal to a plan golden -> TestCreatePostsPlannedBodyByteForByte (uses internal/plan/testdata/planned-issue.md) -> done
- Find false for near match, true for exact -> TestFindExactVersusNearMatch (also TestFindSkipsPullRequests) -> done
- Filing the same DAG twice creates nothing the second time -> TestFilingTheSameDAGTwiceCreatesNothingTheSecondTime, TestCreateIsIdempotentByTitle, TestCreateIdempotentWhenSearchLags -> done
- Epic returns #n's body; missing issue gives a clear error -> TestEpicReturnsBodyAndNamesMissingIssue -> done
Proof it bites: with the exact title compare replaced by `true`, the near-match test failed; with the in-memory id cache removed, TestCreateIdempotentWhenSearchLags failed. Both reverted.
## API change requests
none
## Files outside my area
- internal/tracker/github/tracker.go: added `mu` and `filed` fields to Tracker (the id cache that covers search-index lag) plus the `sync` import.
## Notes on design
- Blocked-by: plancmd already writes the `Blocked by: #n` line into the body, so Create posts the body unchanged and adds no second link form. The data-marker codec was not used; the ticket gave no marker shape for blockers. Say if you want a marker added.
- No labels given means `factory:ready`.
## Gate evidence
`just` is missing, so recipe bodies were run by hand: gofmt (empty), go vet, `go test -race ./...` all ok, static build ok (binary removed), golangci-lint v2.13.2: `0 issues.`
## Learnings
- golangci-lint first run needs several minutes for module downloads; start it in the background at once.
