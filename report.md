TICKET: m3-fixes-s
NEXT: c9fd4b342e132dbc94454c80c3ae9361a0119f08 (my last push; origin/next has since moved to 692d41f by another session)
## Fixed
- Egress SSRF guard missed non-public ranges -> a42a96a, TestNonPublicSpecialPurposeRanges (6to4 and NAT64 judged by embedded IPv4; Teredo, 192.0.0.0/24, 198.18.0.0/15, 240.0.0.0/4 added as netip prefixes; CGNAT and NAT64 were already covered)
- runsc hashed then executed by path -> 384084a (+ d8fac0d errcheck lint fix), TestRunscSwapAfterHashRunsCheckedBytes (binary copied into a fresh 0700 dir while hashing; the copy is exec'd; copy cached per digest)
- Ratchet raised by hand in 479f597 and again in each merge resolution.
## Bite checks
- TestNonPublicSpecialPurposeRanges -> with the old NonPublic: `rules_test.go:117: 6to4 with private v4: 2002:0a00:0001::1 counted as public` (also teredo, benchmarking, reserved, ietf protocol)
- TestRunscSwapAfterHashRunsCheckedBytes -> with exec of the original path: `runsc_test.go:155: command executes the original path /tmp/TestRunscSwapAfterHashRunsCheckedBytes.../001/runsc`
## Not fixed
- Per-ticket refs in the Landlock jail -> left for later, as instructed.
- Copied runsc dirs are not removed at process exit (one per distinct pinned digest, reused) -> exec.Cmd has no post-run hook; not widened.
## Gate evidence
ok  	github.com/KaaS-team/factory/tools/gate	1.067s
ok  	github.com/KaaS-team/factory/tools/prcheck	2.040s
ok  	github.com/KaaS-team/factory/tools/ratchet	(cached)
go_lines 42207 (baseline 42207), deadcode 309 (baseline 309)
(./gate.sh exit 0 on c9fd4b3; go test -race -count=3 passed on pkg/sandbox and pkg/sandbox/egress before the merges)
## Learnings
- Two pushes rejected, then a third race: concurrent sessions all edit .ratchet.json; a script that resolves it (take theirs, re-measure, raise) saved time.
- `git commit -s -m` puts Signed-off-by after a trailer in -m; use --trailer so Co-Authored-By comes last.
- Lint (errcheck on deferred Close) only showed in the 4 minute gate; run golangci-lint on touched packages first.
