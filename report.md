TICKET: m3-fixes-g
NEXT: f67b214e3b2e0185d86d6bba57069401ffe6dacd
## Fixed
- stuck missed errors across different calls -> 2ace27d, TestPatterns/error-run rows (new pattern ErrorRun, nudge only)
- k10 jitter missing from Jobs -> serve: jitter commit, TestJitterOffset, TestJobs_JitterStartsATickEarlyButOncePerPeriod (SetJitter wired in Serve with DefaultJitterWindow; run still keyed by nominal period)
- symlinked import escapes dir -> graph commit, TestImportSymlinkEscapeRefused (read through os.Root; an absolute-target symlink inside the dir is also refused)
- credential check was a name heuristic -> same commit, TestWriteCredentialNames (one table: substrings TOKEN SECRET PASSWORD PASSWD APIKEY PRIVATEKEY CREDENTIAL, words KEY PAT PWD PASS AUTH; PATH, AUTHOR, KEYBOARD stay allowed)
- .ratchet.json raised to 39226 by hand (reason line updated)
## Bite checks
- error-run rows -> "--- FAIL: TestPatterns/error-run:_three_errors_from_three_different_calls_nudge"
- jitter -> "jitter_test.go:55: not fired at its jittered start: 0 runs"
- symlink -> "workflowmd_test.go:184: escape.md: got <nil>, want a refusal"
- credentials (list cut to KEY) -> ""DB_PWD" accepted" / ""DB_PWD" not refused"
## Not fixed
- go/k9-stall "same call repeated N times whatever the result": not ported. stuck deliberately treats a changing result as progress (an existing test says so), so adding it would contradict that.
- stall's chat-completions message shape and string-encoded arguments: not applicable, stuck reads claude stream-json only.
- k10 per-schedule Zone and Skipped flag: Jobs already takes CRON_TZ in the cron spec and runs one catch-up run per tick; FileStore/Store not needed (SQLite cursor).
- go/k9-workflow-md is already an ancestor of next (nothing to merge).
- Left out: no refactor of Jobs, no wiring of an instance id beyond the random holder.
## Superseded branches (not deleted, not merged)
- go/k9-stall: error-across-calls now in internal/dispatch/local/stuck (ErrorRun); the rest is not ported, see above.
- go/k10-catchup: jitter now in internal/serve/jitter.go (Jobs.SetJitter); cron, catch-up and cursor were already in Jobs.
## Gate evidence
just is not installed; ran ./gate.sh (the same steps). Last lines:
ok  github.com/KaaS-team/factory/tools/ratchet
go_lines 39200 (baseline 39200), deadcode 380 (baseline 380)
(that run was before the final merge of origin/next; after the merge I re-ran build, vet, the three touched packages and ratchet: go_lines 39226 (baseline 39226), all ok, then pushed)
go test -race -count=3 on stuck, serve and graph: ok.
## Learnings
- Go 1.26 needs GOTOOLCHAIN=auto; the toolchain download is slow.
- The first gate.sh run exceeds the 120s tool timeout; run it in the background.
- os.Root refuses absolute symlinks even inside the dir.
- Several sessions edit .ratchet.json; expect a conflict and re-measure the total.
