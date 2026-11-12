BRANCH: go/logs-lookup
HEAD: 00b51d75a06ac3b9eca767cbe4fe11d6a28de318
## Summary
The store records the session of each attempt (`PutSession`, `LatestSession`) and `internal/logs` gains `StoreLookup`, `RoutinesFactory` and `LocalFactory` to feed `Backends`. The local dispatcher does not yet write a stream file, so the `local` factory takes the path from the caller.
## Acceptance
- PutSession then LatestSession returns the newest attempt; unknown ticket gives typed not-found -> TestPutSessionThenLatestReturnsNewestAttempt, TestLatestSessionUnknownTicketIsTypedNotFound -> done
- Rebuild leaves the sessions table empty and valid -> TestRebuildLeavesSessionsEmptyAndValid -> done
- logs with a fake routines client prints lines in order; -f follows until ctx ends -> TestStoreLookupFeedsBackends, TestRoutinesFollowRunsUntilContextEnds -> done
- local factory tails a growing file -> TestLocalFactoryTailsGrowingFile -> done
## API change requests
- internal/dispatch/local: Dispatch only pipes stdout into the usage parser. It should also tee the stream to a file (e.g. <state>/sessions/<key>.out) and expose that path and an "ended" check, so cmd can pass them to logs.LocalFactory.
- internal/dispatch/routines has no get_run_log. logs.NewHTTPRunLog (reply shape assumed in internal/logs/routines.go) is the client until it does.
- cmd must call store.PutSession after each Dispatch; nothing records sessions yet.
## Files outside my area
- internal/store/store.go: one line, appends sessionSchema to the schema. Needed so Open creates the table.
## Gate evidence
Run by hand (no just): gofmt -l (empty), go vet ./..., golangci-lint v2.13.2 "0 issues.", go test -race ./... all ok, CGO_ENABLED=0 go build ./cmd/factory exit 0 (binary removed).
## Learnings
- The brief says a `sessions` table, but `sessions` already exists (observer rows keyed by session key). I named mine `dispatched_sessions`. Briefs should check names against the schema.
- Tests broke on first run: `openTemp` already existed in report_test.go. Grep helper names first.
- The mutation check (ORDER BY attempt ASC) turned both new tests red, then reverted. Tests failed first by compile error, so red-before-green was shown for compile, and by mutation for behaviour.
- golangci-lint first run exceeds the 120 s tool timeout; run it in background.
