BRANCH: go/trackers-active
HEAD: 0c7941bbe0c38347fe4945f430fd88b3988f31f2
## Summary
Active is implemented in the GitHub, Linear and Jira trackers and in the porttest fake Tracker, and the fake Observer has Latest. Each tracker answers Active with one paged query. The full gate is not green: `internal/store` tests fail on this branch because the fake Tracker now has `Active` (see API change requests).
## Acceptance
- GitHub: Active returns running and verifying, not ready or done, request matches golden -> TestActiveListsBuildingAndVerifyingWithOneQuery (testdata/active_request.golden), TestActivePropagatesAPIError -> done
- Linear: same, with request golden -> TestActive, TestActiveRequestMatchesGolden (testdata/go-IssuesActive-0.json) -> done
- Jira: same, with request golden -> TestActive, TestActiveSendsJQL (asserts the full request body) -> done
- porttest: Active after running includes the ticket, after done not; Latest returns attempt 2 when 1 and 2 exist -> TestTrackerActiveFollowsPhase, TestObserverLatestReturnsHighestAttempt -> done
- Existing tests in all four packages pass unchanged -> done (fake_test.go files in linear and jira gained filter support for the new query shape; no existing test edited)
## API change requests
- Cross-session break: `internal/store` `TestRebuildMatchesLive` and `TestPhasesStored` fail once porttest.Tracker has `Active`. `Store.Rebuild` prefers `Lister.Active`, so it now sees only claimed-or-later tickets from the fake, and the test expects ready ticket 3 and fresh-store rows. Both pass on origin/next without my change. I left `internal/store` untouched (outside my area). The store session should set phases in `fakes()` (running for 1 and 2) and decide whether a ready ticket belongs in a rebuild. Merging this branch before that lands turns `next` red.
- GitHub has no phase for verifying, and in-review is shared by done and merge-queue. Active therefore covers labels factory:building and factory:verifying only. A ticket in merge-queue is not listed for GitHub. Linear and Jira include the merge-queue status when it is mapped.
## Files outside my area
none
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt clean, `go vet ./...` clean, golangci-lint v2.13.2 "0 issues.", `CGO_ENABLED=0 go build ./cmd/factory` ok. `go test -race ./...`:
ok  	github.com/KaaS-team/factory/internal/tracker/github	1.138s
ok  	github.com/KaaS-team/factory/internal/tracker/jira	1.075s
ok  	github.com/KaaS-team/factory/internal/tracker/linear	1.068s
FAIL	github.com/KaaS-team/factory/internal/store	0.174s
(`internal/api/porttest` passes.)
## Learnings
- A fake that gains an optional interface changes behaviour in every package that type-asserts for it; the ticket should name the consumers (here `store.Rebuild`) before the fake changes.
- `just` is not installed in the cloud image; preinstalling it would save the by-hand recipe run.
- `go run golangci-lint@...` takes over two minutes on a cold cache; run it in the background at the start.
