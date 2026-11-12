TICKET: m3-fixes-k5
NEXT: 27e0113
## Fixed
- 1 Loop guard nudge never resets -> 060802a, TestNudgeResetsAfterProgress (stuck.nudged clears on a different action; the caller comment now says a local session has no Steer, so the nudge only counts)
- 2 Abort replaces a clean exit -> 14d13b4, TestAbortDoesNotReplaceCleanExit (exitErr keeps a process that exited 0)
- 3 Egress wildcard over a public suffix -> 0417799, TestNewSecretsGate cases (golang.org/x/net/publicsuffix, already in go.sum, now a direct require; NewSecrets(0) means DefaultMinWildcardLabels)
- 5 Replay fixtures can store secrets -> 6bab225, TestSaveRedactsCredentials (save uses sanitize.RedactSecrets on a copy)
- 6 Merge queue livelock -> eba4e8d, TestRunNonFFIsCappedAndParked (Config.PushAttempts, default DefaultPushAttempts=5; batch ejected with the reason)
- 4 Tests write into the tree -> a937414, TestCommandRejectsRebindingHost now passes --audit-log and asserts the file lands there; TestDefaultAuditLogIsUnderDataDir; default is .factory/a2a-audit.jsonl (dir made on start, gitignored); 7078076 regenerates docs/cli-reference.md
- ratchet raised: 0c8508c, and in the merge 27e0113 (took the larger counts, one reason line, re-measured 37409 / 342)
## Bite checks
- TestNudgeResetsAfterProgress -> stuck_test.go:220: stall after progress: [{2 monologue stuck in a monologue loop after a nudge}], want one nudge
- TestAbortDoesNotReplaceCleanExit -> local_test.go:380: exit 0 before the kill: local: run is stuck in a loop: test, want nil
- TestNewSecretsGate -> wildcard_over_a_public_suffix: err = <nil>, ok want false (also the private-suffix and zero-depth cases)
- TestSaveRedactsCredentials -> replay_test.go:235: fixture holds the token
- TestRunNonFFIsCappedAndParked -> outcome_test.go:151: attempts 0: context deadline exceeded (retries never stop)
- TestCommandRejectsRebindingHost -> a2a_test.go:332: the audit file is not at the path given (and the run left internal/a2a/.factory behind)
## Not fixed
- none
## Gate evidence
`just` is not installed, so I ran ./gate.sh (the same steps). On the commit before the merge it exited 0; last lines:
ok  	github.com/KaaS-team/factory/tools/ratchet	1.018s
go_lines 34154 (baseline 34154), deadcode 299 (baseline 299)
exit 0
After merging fresh origin/next I ran build, vet, the ratchet and `go test -race` on the touched packages and cmd/factory (all ok), then pushed, per the retry rule. The full gate was not re-run on the merge.
## Left out
- Other redactors (tracker/github.Redact, logs.Redact) are untouched; I used sanitize.RedactSecrets, which only covers GitHub, Anthropic, AWS, Slack and JWT shapes.
- A history that holds a token will now diverge from its redacted fixture on replay; I did not change replay.
- The brief's commit trailer names a model, which its own rules and the session rules forbid; commits carry no trailer and no session link.
- go test -race -count=3 was run on touched packages before the merge, not after.
## Learnings
- go.mod needs GOTOOLCHAIN=auto here (Go 1.24 installed, module needs 1.26).
- docs/cli-reference.md is a golden file: a changed flag default needs UPDATE_GOLDEN=1 go test ./cmd/factory.
- A stop hook wanted committer noreply@anthropic.com, so I rewrote the unpushed commits before pushing.
- The full gate takes over 2 minutes; run it in the background.
