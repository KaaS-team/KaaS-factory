BRANCH: go/meter-cloud
HEAD: 62231231b044abcd170645d3353f473ae62e92d4
## Summary
`routines.EventUsage` reads absolute usage from session events and returns `ErrNoUsage` when there is none. `meter.CloudUsage` turns repeated polls into deltas and records runs with no usage as unknown, shown as "unknown" and as `unreportedRuns` in the ledger.
## Acceptance
- Recorded run-log fixture yields expected totals -> TestEventUsageReadsTheRecordedRunLog, TestEventUsageBranches -> done
- Three polls with growing totals record deltas once; repeat adds nothing -> TestCloudPollsRecordDeltasOnce -> done
- No usage records unknown and the ledger says so -> TestCloudUnknownIsRecordedAsUnknown, TestCloudSpendSumsRunsAndCost -> done
- No token count leaves the operator path -> blocked (no customer-facing template exists in my area, so there is nothing to scan; Describe and Spend are operator-side only)
## API change requests
None. The events endpoint (`GET /v1/code/sessions/{id}/events`, `{"data":[{"type":"result"|"usage","usage":{...}}]}`) is my assumption, like the rest of the routines wire shapes, and is not confirmed against the live service. The existing `Dispatcher.Usage` still returns zero Usage when the session object has no usage; callers should use `EventUsage` and pass nil to `CloudUsage.Poll` on `ErrNoUsage`.
## Files outside my area
None.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt (empty list), go vet, golangci-lint v2.13.2 ("0 issues."), `go test -race ./...` (all packages ok), CGO_ENABLED=0 build (binary removed).
## Learnings
- A stray interactive `git checkout -p` hung the shell while a mutation was still applied; never run interactive git in a mutation check, restore from a backup copy.
- Mutation proof: dropping `c.known[k] = true` failed 5 tests; dropping the result-event preference failed 2.
- The first golangci-lint run took longer than the tool timeout; starting it in the background worked.
