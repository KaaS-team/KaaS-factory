BRANCH: go/k8-untrusted-pr
HEAD: fe8535371a70d073df70dcb88362c6ddab6cb74c
## Summary
New `internal/dispatch/untrusted` (deny list, author check, argv merge, snapshot/restore guard) and a small opt-in hook, `Config.Untrusted`, in `internal/dispatch/local`. The hook is not wired from `cmd/factory`, so `Deny` is unreachable from the CLI until someone supplies the author lookup.
## Acceptance
- PRs from authors without write access run with a deny list that overrides allows -> `TestDeny` (7 rows: admin, write, read, none, lookup failure, bot, no author), `TestMergeDenyOverridesAllows`, `TestUntrustedSessionIsGuarded/untrusted_author` -> done
- git config and SENSITIVE_PATHS snapshotted before, restored after -> `TestGuardRevertsPlantedSettings`, `TestGuardLeavesUnchangedAndHandlesSymlinks` -> done
- a test plants a modified `.claude/settings.json` in a PR and shows it is reverted -> `TestUntrustedSessionIsGuarded` (agent script rewrites it; trusted row keeps the plant) and `TestGuardRevertsPlantedSettings` -> done
- Bite-checks (revert, watch red): restore call removed -> TestUntrustedSessionIsGuarded fails; MergeDeny call removed -> fails on argv; guard restore made a no-op -> both guard tests fail. The "lookup failure counts as trusted" mutation only broke the build (unused var), so that row was not bitten.
- Left out: upstream warnings about uncovered Bash rules (`isDenied`) and the RESTRICT_UNTRUSTED_PRS switch, the retry/backoff on the permission lookup, FIFO-safe O_NONBLOCK open (Lstat-based opaque skip used instead), git program disabling (`disableGitPrograms`). Reason: not in the acceptance lines, and the repo is over its line budget.
## API change requests
none
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: required section for the ported files.
- Needed from the owner of `cmd/factory` / dispatch wiring: set `local.Config.Untrusted` to a func that calls `untrusted.Deny(ctx, access, prAuthor)`, with `access` backed by the REST collaborator permission call. `api.Brief` has no PR author field, so the func needs it from elsewhere.
## Gate evidence
`just` is not installed; ran the recipe bodies by hand: `gofmt -l` (clean), `go vet ./...`, golangci-lint v2.13.2 under go1.26.7 ("0 issues."), `go test -race ./...` and `-tags ee` (all ok), `CGO_ENABLED=0 go build ./cmd/factory` (BUILD_OK). `internal/smoke TestRunMergesTheTicket` failed once under a full run and passed 3 of 3 reruns, so it looks flaky and unrelated.
Measures: non-test Go lines 21276 -> 21514 (+238; the +238 includes my files at that moment, pre-gofmt). Deadcode lines 70 -> 75; the only one in my area is `untrusted.Deny` (unreachable until wired).
## Learnings
- `just` is missing in cloud sessions; the brief's by-hand recipe list worked.
- A cold `go run` of lint and deadcode exceeds the 120 s tool timeout; run them in the background.
- Brief says nothing on how the PR author reaches the dispatcher; the ticket should name the `Brief` field or the hook.
