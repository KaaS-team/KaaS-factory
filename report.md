TICKET: m1-g
NEXT: bbda815
## Merged
- go/k9-a2a-v1 -> 9dcda37
- go/k9-workflow-md -> d53635d
## Skipped
- go/k9-scim -> pushed 6+ times and lost the race each time (several sessions push to next; the gate takes longer than the gap between pushes). Merge is clean, its gate passed on every attempt except one run that hit a stale CLI-doc test already fixed on origin/next. Retry budget spent; needs a quieter window.
- go/k9-stall -> conflict in internal/dispatch/local/local.go, local_test.go, THIRD_PARTY_NOTICES.md. next already has a stuck detector (internal/dispatch/local/stuck, Nudge/Abort via the same stdout loop); the branch adds a second, separate detector (internal/dispatch/stall, a Stalled() query). Which one wins, or whether both stay, is a design call.
- go/k10-catchup -> conflict in internal/serve/serve.go, serve_test.go, THIRD_PARTY_NOTICES.md. next already has Jobs (cron, catch-up, cursor) in internal/serve; the branch adds a second Scheduler (cron, catch-up, jitter) wired through Options.Schedule. Two schedulers for one serve loop is a design call.
## Review notes
- k9-a2a-v1: clean. Bearer guard covers both v1 and v0.3 paths; audit rows hold no message text.
- k9-scim: tenant checks go through own() on every item handler. Small gap: a PATCH that replaces displayName with an empty string is not rejected (Replace and Create reject it). Not fixed.
- k9-workflow-md: imports are checked with filepath.IsLocal, but os.ReadFile follows symlinks, so a symlinked import can leave the directory. checkNoWriteCredential is a name heuristic (TOKEN, SECRET, _KEY, :write) and misses names like PASSWORD or GH_PAT. Not fixed. I reviewed this diff after the push, not before.
- k9-stall, k10-catchup: not reviewed in depth, merges aborted.
## Gate evidence
ok  	github.com/KaaS-team/factory/tools/gate	1.036s
ok  	github.com/KaaS-team/factory/tools/ratchet	(cached)
built
go_lines 30907 (baseline 30907), deadcode 233 (baseline 233)
(just is not installed here; the recipes were run by hand: gofmt, go vet, golangci-lint v2.13.2 under go1.26.7 with 0 issues, go test -race with and without -tags ee, static build, ratchet.)
## Learnings
- just missing; ran the check recipes by hand through a script.
- Pushes to next are contended; each gate run takes long enough to lose the race, so one branch burned all its retries.
- git rebase flattens merge commits; redo the merge on a fresh origin/next instead.
- go.mod/go.sum conflicts recur with every merge; strip markers, sort -u go.sum, go mod tidy.
