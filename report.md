TICKET: m1-d
NEXT: 61228cbcd74095d90866434c367fba2713bffdd7
## Merged
- go/k8-cred-broker -> 2e13fca
- go/k8-host-guard -> 1c86791 (conflicts in THIRD_PARTY_NOTICES.md, internal/a2a/command.go, internal/a2a/a2a_test.go against k9-a2a-v1: kept both sides, the a2a handler is wrapped in hostguard.New)
- go/k8-mergeq-outcomes -> dbbe80f
- follow-up on next: db1b3f5 broker: refuse dot and empty path segments (see Review notes)
## Skipped
- go/k8-agent-token -> not skipped for a defect: it merged clean and passed the gate (ee/identity, race and ee tags), but all push attempts were rejected because other sessions pushed to `next` first. Re-run it.
- go/k8-lockfile -> same: only a THIRD_PARTY_NOTICES.md conflict (keep both), gate green, six rejected pushes. Re-run it.
## Review notes
- k8-agent-token: clean. Minor: Authorize with a nil Gate would panic; Verify of a token with no "exp" is rejected as expired, which is correct.
- k8-cred-broker: real bug, fixed in db1b3f5 with a test that fails without it. githubConn.Classify used url.Parse(target).Path and accepted ".." / "." / empty segments, so the gate could approve repos/o/r while upstream normalised the path to a different resource (e.g. PATCH /repos/o/r/pulls/.. , GET /repos/o/r/%2e%2e/..). Now ErrUnclassified. Also noted: Classify ignores the host of target, and the minted credential is the full-scope source token (the code comment says so).
- k8-host-guard: clean. Any loopback Origin is allowed whatever its port, so another local web page can pass the origin check; the bearer token is the remaining guard.
- k8-lockfile: clean (v1 reader kept, conflict markers detected). A lock with only comments and no version line parses as empty rather than erroring.
- k8-mergeq-outcomes: clean. A push that is never a fast-forward retries the whole batch with no cap on attempts (a livelock if PushBackoff is zero); worth a cap later.
- origin/next was red on its own twice: TestCLIReferenceFresh (docs/cli-reference.md stale after `packs migrate`). I regenerated it in the pushes (UPDATE_GOLDEN=1 go test ./cmd/factory).
- A test in internal/a2a (default --audit-log a2a-audit.jsonl) writes that file into the package dir. A gate run left it and an automated commit of mine added an empty copy in 1c86791..; it is removed again by a later commit. The test should use t.TempDir().
- Ratchet reason on the last ceiling commit names "go/broker-dots", which is my follow-up fix, not a branch.
## Gate evidence
ok  	github.com/KaaS-team/factory/tools/gate	1.042s
ok  	github.com/KaaS-team/factory/tools/ratchet	(cached)
go_lines 31673 (baseline 31673), deadcode 243 (baseline 243)
(`just` was not installed; I ran the check recipe by hand: go mod tidy, gofmt -l, go vet, golangci-lint v2.13.2 via go run with GOTOOLCHAIN=go1.26.7, go test -race plus the ee tag, static build, go run ./tools/ratchet. The golangci-lint on PATH was built with Go 1.25 and cannot load the config.)
## Learnings
- Gate takes minutes while several sessions push; 6 tries were not enough for two branches. Pushing right after the gate with a fetch-and-merge in between loses most races.
- `git rebase origin/next` flattens the merge commit and hits .ratchet.json; redoing the merge on a fresh origin/next was simpler.
- golangci-lint on PATH is Go 1.25: use the `go run ...@v2.13.2` path.
