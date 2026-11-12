TICKET: m3-fixes-f2
NEXT: 0e7b746
## Fixed
- Spend cap ignores per-day spend -> 772a262, TestAllowCountsPerDaySpend (internal/meter/cap). One resolver, meter.InWindow (today's rows plus undated rows for the holder); Gate gets a Now clock.
- Untrusted guard restores from the PR checkout -> 10a5e19, TestGuardRestoresFromBaseNotCheckout (untrusted), TestUntrustedRunUsesBaseSettingsNotThePRs (local), TestSnapshotFailsOnUnknownBase. Snapshot(dir, base) reads the sensitive paths from `git ls-tree`/`cat-file` of origin/<base>; a path the base lacks is removed; the dispatcher restores once before the agent starts, so the run starts on the base's settings.
- Config.Untrusted never used -> 369d3b1, TestLocalDispatchRestrictsUntrustedAuthors (cmd/factory, real local dispatcher, fake `claude` and GitHub server). On the github tracker a brief whose ticket is a pull request gets untrusted.Deny for its author; an unreadable author counts as untrusted; an issue is not restricted.
- a2a-audit.jsonl tracked -> f022763. Still tracked when I started (k5 had only moved the default path). `git rm --cached`, `.gitignore` now ignores `a2a-audit.jsonl` at any depth, TestCommandRefusesEmptyToken passes a TempDir --audit-log (the other a2a tests already used TempDir).
- .ratchet.json: go_lines raised by hand with a reason line (aa2066c, and in the merge 0e7b746 where it conflicted with origin/next: larger go_lines and deadcode taken).
## Bite checks
- TestAllowCountsPerDaySpend -> with the window reverted to undated rows only: `cap_test.go:167: over = false, want true` (only today's day rows at the cap).
- TestGuardRestoresFromBaseNotCheckout -> with file content read from the checkout: `untrusted_test.go:257: settings.json = "{\"permissions\":{\"allow\":[\"Bash(*)\"]}}", want the base's`
- TestUntrustedRunUsesBaseSettingsNotThePRs -> same revert: `settings at the end = {"permissions":{"allow":["Bash(*)"]}}, want the base's {"permissions":{"allow":["Bash(git status *)"]}}`
- TestLocalDispatchRestrictsUntrustedAuthors/1 -> with the hook not set on the config: `untrusted_test.go:93: deny list in argv = false, want true`
- Defect 4 has no behavioural test (a tracked-file fix); no bite check.
## Not fixed
- Nothing skipped. Left out: meter.Ledger.Add (thread.go) still matches `Day == ""` rows, which is the row it updates, not the cap window. Restrict on a git-less worktree now fails Dispatch (Snapshot needs a resolvable origin/<base>), which fails closed.
## Gate evidence
(./gate.sh after the last push, exit 0, no FAIL lines)
ok  	github.com/KaaS-team/factory/scripts/price-refresh	(cached)
ok  	github.com/KaaS-team/factory/tools/gate	1.034s
ok  	github.com/KaaS-team/factory/tools/ratchet	(cached)
go_lines 39323 (baseline 39323), deadcode 379 (baseline 380)
## Learnings
- `go build ./cmd/...` and a gate run while editing give confusing vet failures; do not edit during a gate run.
- Brief carries no PR author; the author comes from GitHub Issues.Get on the ticket number (a PR is an issue with pull_request set).
- `dir` is also a kind constant in the guard package, so a `dir` parameter shadows it.
- A merge into next moved go_lines twice in one session; re-run the ratchet after every merge.
