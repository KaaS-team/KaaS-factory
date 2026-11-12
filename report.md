TICKET: m1-f2
NEXT: 0cf74a1 (my last push; origin/next has since moved on to 85a0c17 with 0cf74a1 as an ancestor)
## Merged
- go/k8-spend-cap -> 6d53ffe (clean; fix 7ee1d31)
- go/k8-untrusted-pr -> 75d74eb (conflicts in local.go and THIRD_PARTY_NOTICES.md, kept both; fix cf1b5a2)
- go/k6-plan-files -> 85841af (the brief said clean, but it conflicted in internal/mergeq/run.go with the push-retry `Sleep` field and `pushRetries` arg; kept both)
- go/k8-agent-token -> 4a152bd (clean; fix 70d147b)
- go/k8-lockfile -> cab2a18 (THIRD_PARTY_NOTICES.md only, kept both; fix 7a69535)
- Pushed as 0cf74a1 after merging origin/next once (conflicts in .ratchet.json and THIRD_PARTY_NOTICES.md; took the larger counts, kept both sections, re-measured: go_lines 35284, deadcode 303). One push, no retries.
## Skipped
- none
## Bite checks
- TestSessionCapFailsClosedWithoutLedger (control.go reverted) -> `spendcap_test.go:73: err = <nil>, sessions = 1`
- TestAuthorizeNilGateIsAnError (nil check reverted) -> `panic: runtime error: invalid memory address or nil pointer dereference`
- TestParseLockWithoutVersionLineIsAnError (version check reverted) -> `lockfile_test.go:63: comments only: want missing version header error, got <nil>` (and the same for blank)
- TestUntrustedArgvAllowsOnlyAllowlistedBash (Restrict call swapped for MergeDeny) -> `untrusted_test.go:85: Bash(find *) in argv = true, want false`
- TestUntrustedSettingsRestoredMidRun (mid-run restore disabled) -> `--- FAIL: TestUntrustedSettingsRestoredMidRun (6.18s)`
- TestPermittedAllowlist ("env *" added to the allowlist) -> `Permitted("env sh -c ./evil") = true, want false`; ("find *" added) -> `Permitted("find . -name x") = true, want false`
- TestRestrictCutsAllowRulesToAllowlist (dontAsk check removed) -> `untrusted_test.go:226: no mode: want an error`
- `guard` -> `loop` rename: no separate test. With the old name `guard.Restore()` called the stuck detector's variable and did not compile.
## Review notes
- go/k8-spend-cap: the fail-open above, fixed. Open: `Gate.Allow` counts only ledger rows with `Day == ""` and the team holder, so spend recorded per day does not count toward the cap.
- go/k8-untrusted-pr: the blocklist was bypassable by `env`, `xargs`, `find -exec` and hook-firing git commands, and the preset itself allows `find *`. Now `untrusted.Restrict` cuts the settings' allow list to read-only git plus `.factory/gates.sh`, and fails closed unless the run is in `dontAsk` mode with a `--settings` value. The deny list stays as a second layer, extended with env, xargs, find, exec, nohup, timeout and the hook-firing git commands. `Permitted(cmd)` is the table oracle for the allowlist; the table covers env, xargs, find -exec, git commit/checkout/merge/rebase/push/stash, `git -c`, `git config`, chaining, pipes, substitution, near-miss gate paths, make and npm.
- go/k8-untrusted-pr, residual risk: `Config.Untrusted` is not wired into cmd/factory yet. The preset still passes `--setting-sources project,local`, so the checkout's own `.claude/settings.json` allow list is read. The guard restores it to the checkout state, and it should be restored from the base branch.
- go/k6-plan-files: `Git.Stale` is clean (a non-zero git exit comes back as an error, not "applies"). `returnToAgent` puts conflicting paths, which come from the PR, into a tracker comment inside backticks.
- go/k8-agent-token: the nil gate panic, fixed. Otherwise clean.
- go/k8-lockfile: the no-version-line case, fixed. An empty or whitespace-only file is now an error too (the same code path); I found no caller that relies on an empty file parsing.
- Mid-run restore: it was cheap (Restore only walks the recorded paths and runs no git), so it now runs at most once a second from the output loop, plus once at the end. The first error from either is reported at the end.
## Gate evidence
(`just` is not installed here, so `./gate.sh` ran instead, which is the `check` recipe: fmt vet lint test build ratchet, with `-race` and the `ee` tag.)
ok  	github.com/KaaS-team/factory/tools/gate	1.035s
ok  	github.com/KaaS-team/factory/tools/ratchet	(cached)
go_lines 35284 (baseline 35284), deadcode 303 (baseline 303)
GATE_EXIT 0
`go test -race -count=3` on internal/core, dispatch/local, dispatch/untrusted, mergeq/..., meter/..., packs, plan and ee/identity (ee tag): all ok.
## Left out
- No wiring of `Config.Untrusted`, no change to `--setting-sources`, no change to the per-day ledger rows, and no refactors or doc edits beyond the notices and ratchet files.
## Learnings
- internal/a2a/a2a-audit.jsonl is tracked on next (a session committed it), so a plain `git merge origin/next` aborts when the a2a tests have left an untracked copy. Delete the local copy first; someone should `git rm` it and ignore it.
- Go 1.26 comes through GOTOOLCHAIN=auto, but the first run downloads the toolchain and every module, so budget about 2 minutes. The full gate takes about 3 minutes.
- Commands over 120s are moved to the background by the harness; poll the log instead of re-running.
- The brief said k6-plan-files merged cleanly, but it conflicts in mergeq/run.go now that the push-retry work is on next.
- The brief's no-model-name rule and its required `Co-Authored-By: Claude Opus 5.5` trailer pull in opposite directions; I used the trailer as written.
