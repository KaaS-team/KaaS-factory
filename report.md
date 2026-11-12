BRANCH: go/k7-review-only
HEAD: b012d0922c71848c4642c678a950fb9075e0c895
## Summary
Added `internal/review`: a runner that gives each check a disposable worktree (HEAD plus staged, unstaged and untracked changes), runs an agent under a diff-only scoped prompt, and returns name, status, patch, output and duration. Not yet reachable from `cmd/factory` (see API change requests).
## Acceptance
- Each check runs in a worktree seeded from HEAD plus uncommitted changes -> TestWorktreeSeededWithUncommittedState -> done
- Result is name, status, patch, output, duration; empty patch means pass -> TestResultRecord -> done
- Worktree removed on crash and timeout -> TestWorktreeRemovedOnCrashAndTimeout (panic, timeout, agent error) -> done
- Diff truncated at a configured byte cap with notice; diff-only scoped prompt -> TestPromptScopeAndTruncation -> done
- review-only workflow file -> TestWorkflowFileLoads (`internal/review/review-only.yml`, loads via graph.Load) -> done, but placed in my package, not `.factory/workflows/` (outside my area). Its `run: factory review` names a command that does not exist yet.
- Bite-check: removed cleanup, untracked copy, uncommitted apply, truncation, patch-to-fail and timeout status one at a time; each turned a test red.
- Left out (not in my ticket line): check-pack format (other session), CEL permission preset, auth pre-check, Go port of rule applicability. Source is a small `Source` interface with a fake in tests.
## API change requests
- `cmd/`: add a `factory review` command that builds `review.Runner` with the checkmd Source and a local agent, so the package is reachable. Move `review-only.yml` to `.factory/workflows/`.
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: continuedev/continue@5522c6f section, required by the provenance test.
## Gate evidence
`just` is not installed; ran the recipe bodies by hand. gofmt clean, `go vet ./...` clean, golangci-lint v2.13.2 `0 issues.`, `go test -race ./...` no failures, `CGO_ENABLED=0 go build ./cmd/factory` BUILD_OK.
Non-test Go lines (outside src/): before 20980, after 21267 (+287). Deadcode: before 78, after 78 (package unreachable from main, so it is not counted yet; wiring will make it count).
## Learnings
- `just` missing in cloud sessions: the factory image should install it.
- go test -race ./... plus lint exceeds the 120s tool timeout; run it in the background.
- Workflow-file location conflicts with the "never edit .factory/" rule; the brief should name a path.
