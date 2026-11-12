BRANCH: go/k4-sandbox-harden
HEAD: a99e2931945ec263663865bdd084b9cda3e1a6f5
## Summary
The jail no longer grants the whole `.git` or the operator's `~/.claude`: it grants only objects, refs, logs, the session's own `worktrees/<name>`, `/dev/null`, and a private per-session `CLAUDE_CONFIG_DIR`. Host `git worktree add` runs with `core.hooksPath=/dev/null`.
## Acceptance
- Sandboxed fake agent cannot write `.git/hooks/post-checkout` or `.git/config`, can write its worktree and commit -> TestSandboxBlocksGitHooksAndConfigButNotTheWorktree (skips with probe reason without a jail; ran and passed here with Landlock) -> done
- Session config dir is not the operator's `~/.claude`; writable list checked -> TestWritablePathsNeverIncludeHooksConfigOrOperatorClaude, TestSessionConfigDirIsPrivateAndCarriesOnlyTheLogin, TestSandboxDispatchUsesSessionConfigDir -> done. The dir holds only `.credentials.json` copied from the operator's config. If the login is not a file (macOS keychain) the dir starts empty. I could not run a real `claude` login here, so the login working this way is untested.
- Parent `ANTHROPIC_API_KEY=x` does not reach the child env -> existing TestChildEnvHasNoProviderVariables and TestSandboxDispatchRunsAgent (already cover it, always run) -> done; I added no new test for it.
- Also: host git ignores hooks -> TestWorktreeAddIgnoresHooks.
- Measures: non-test Go lines 20357 -> 20403 (+46). Deadcode 68 -> 68 (measured against a clean origin/next worktree). Nothing added is unreachable from cmd/factory.
## API change requests
none
## Files outside my area
- `cmd/factory/control.go`: the sandbox line only (`Writable` -> `GitDir`). `Config.Writable` was removed from `local.Config` (also re-exported through `pkg/agentrun`); no other user.
- `internal/dispatch/local/.gitignore` (new, ignores the test's temp repo dir; inside my area).
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt, `go vet ./...`, golangci-lint v2.13.2, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`: all passed. Last lines:
ok  	github.com/KaaS-team/factory/pkg/agentrun	1.039s
ok  	github.com/KaaS-team/factory/pkg/sandbox	1.288s
## Learnings
- Landlock cannot make a subpath read-only under a writable parent, so "keep hooks and config read-only" means listing the allowed subpaths, not carving exceptions.
- The jail never allowed writing `/dev/null`, so git inside it failed; `/dev/null` is now listed.
- A test repo under `t.TempDir()` sits inside the jail's writable `/tmp`, so the hook/config test passed for the wrong reason until the repo moved outside TMPDIR. Jail tests need a repo outside the temp dir.
- Other host git callers (`internal/gitx`, `internal/mergeq/wire/git.go`, `internal/smoke`) are outside my area and still run without `core.hooksPath=/dev/null`; a follow-up should add it.
- `just` is missing in cloud sessions.
