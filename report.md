BRANCH: go/k6-checkmd
HEAD: e124964b51b2ec68ccd619ae61902c9b07ef9257
## Summary
New `internal/packs/checkmd/` reads markdown check packs (front matter name, description, globs, regex) and filters them by glob, negated glob, regex and directory colocation. It also runs each check in a disposable worktree seeded from HEAD plus uncommitted and untracked files, with a diff-only prompt capped at a byte limit.
## Acceptance
- Pack whose globs miss the diff is not loaded or prompted -> TestApplies/glob_miss, TestSelectDropsPacksThatMissTheDiff -> done
- Negated globs work -> TestApplies (negated only, positive plus negated rows) -> done
- Unit tests for glob, regex, directory colocation -> TestApplies rows, TestParse -> done
- NOTICE entry for Apache-2.0 ported logic -> `## continuedev/continue@5522c6f` in THIRD_PARTY_NOTICES.md, internal/provenance test passes -> done
- Result record is name, status, patch, output, duration; empty patch is pass -> TestRunEmptyPatchPassesAndSeesUncommittedState, TestRunPatchIsFailAndOnlyAgentChanges -> done
- Worktree removed on crash and timeout -> TestRunRemovesWorktreeOnTimeoutAndPanic -> done
- Diff truncated at byte cap with notice -> TestPromptScopeRulesAndTruncation -> done
- Bite-check: each fix reverted once (negation, colocation, regex, glob-miss filter, worktree removal, patch status, truncation, panic recovery); the named test went red every time, then restored.
- Ticket 3 (kaasbot/gate preset list), the other ticket-table rows (anti-slop and stale-comments packs, auth-check step) -> not done: outside my area `internal/packs/checkmd/` only.
## API change requests
- Nothing in `cmd/factory` calls checkmd yet, so its exports are unreachable (deadcode 68 -> 84). Wiring needs an edit outside my area: load `*.md` packs from the checks directory, call `checkmd.Select`, then `Runner.Run` with an adapter that implements `checkmd.Agent` over the dispatcher.
- Worktree code uses its own argv `git` exec rather than `internal/gitx`, since gitx is outside my area. Moving it to gitx is a follow-up.
## Files outside my area
- `go.mod`, `go.sum`: added `github.com/bmatcuk/doublestar/v4 v4.9.1` (MIT; the ticket names it).
- `THIRD_PARTY_NOTICES.md`: the required notice section.
## Gate evidence
`just` is not installed, so I ran its recipes by hand. `gofmt -l` clean, `go vet ./...` clean, `go test -race ./...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` ok. golangci-lint v2.13.2 on `./internal/packs/...` only: "0 issues." (not run repo-wide).
Measures: non-test Go lines 20357 -> 20702; deadcode lines 68 -> 84 (all from the unwired exports).
## Learnings
- The brief's no-session-trailer rule conflicts with the harness's default commit trailer; the brief won, with Co-Authored-By only.
- The per-check timeout must cover only the agent, not worktree setup, or a tight timeout kills `git commit` and gives a misleading error.
- A brief that bars wiring files but requires reachability from `cmd/factory` cannot be met; the brief should name the wiring owner.
