TICKET: m2-k3b
NEXT: e36218c314dcdea2f94789641376bde922e87745
## Merged
- none. I pushed nothing to next, because every branch was already there.
## Skipped
- none
## Already on next
- go/k3f-meter -> merged to next as c88b547 ("k3f-meter: merge session branch"). Merging the branch again conflicts only in internal/meter/thread.go and internal/tracker/github/spend.go, and next's versions are the later ones (Thread is now api.Thread, per k4-meter-thread ccc386b). Taking next's side leaves an empty diff against next. ledger_test.go and thread_test.go are identical to the branch tip.
- go/k3f-surface -> merged to next as 8ec930d. cmd/factory/surface_test.go and sandbox_test.go are identical to the branch tip. The conflicts in cmd/factory/main.go, docs, a2a, browsercheck, config/keys.go and dispatch/local/local.go are later edits on next. internal/upgrade/self.go was deliberately removed by k4-packs-upgrade (656c4c6); cmd/factory/main.go now mounts internal/selfupdate. I did not restore it.
- go/k3f-rest -> merged to next as 8689989. shadow/file.go and file_test.go are identical to the branch tip. internal/logs/local.go, internal/pick/route.go and internal/packs/upstreams.go are deleted on next. The conflicts in main.go, docs/cli-reference.md and internal/mcp/mcp.go are later edits on next.
The three branch tips are not ancestors of next, because earlier merges were rebased or re-committed under new SHAs. A merge of any of them that keeps next's side adds no content, and I did not make one: it would only record ancestry, and the brief says never to revert a next feature to make a branch fit.
## Bite checks
- none: I wrote no code, so there was no fix to revert.
## Review notes
- go/k3f-meter: I read the diff. internal/meter/thread.go has a redundant "if next != *a" directly after "if next == *a { return nil }". It is harmless, and next already has it.
- go/k3f-surface: not reviewed in full, since it is already on next.
- go/k3f-rest: not reviewed in full, since it is already on next.
## Gate evidence
No gate run: the tree is unchanged from origin/next.
## Learnings
- just is not installed here. go 1.24.7 needs GOTOOLCHAIN=auto, which fetched go1.26.0 through the proxy.
- The branch tips are not ancestors of next even though their content landed. Check content with git diff <tip> origin/next -- <file> before spending time on conflicts.
