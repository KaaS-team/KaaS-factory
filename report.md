TICKET: m2-k5a
NEXT: c819168a4cbb63f05ff869131def616e7af92a7e
## Merged
- go/k5-browsercheck-lean -> 55ec119ebadb362797f43e67aafa521b4041bef8
- go/k5-egress-secrets -> 8034039cd5f4470d9d76b4ce54e19c833125ac02
- go/k5-loop-guard -> c819168a4cbb63f05ff869131def616e7af92a7e
## Skipped
- none
## Already on next
- none
## Bite checks
- none: I found no bug to fix in any of the three diffs, so I added no code and no test.
## Review notes
- go/k5-browsercheck-lean: clean. Secret scoping fails closed on an empty host and on a host outside the domain. Redact runs on the failure message. The profile temp dir is removed by flock-guarded sweep. Residual: Redact covers only the text passed to it, so a screenshot of a page that shows a typed secret is not masked (the doc comment says "not a sandbox").
- go/k5-egress-secrets: clean. Placeholders resolve only in headers, over TLS, to hosts the secret lists. Rules are checked on every resolved address and the dial uses the checked address. Residual: the wildcard depth gate counts labels, so "*.co.uk" (2 labels) passes and covers every co.uk host. NewSecrets(0, ...) turns the gate off.
- go/k5-loop-guard: clean. The nudge is not delivered, because Steer is unsupported, so the first hit only counts and the next one aborts. g.nudged is set by an action-error nudge and never reset, so any later pattern then aborts at once. An abort that lands just as the process exits normally replaces a clean exit with ErrStuck.
- Conflicts: THIRD_PARTY_NOTICES.md conflicted on each of the merges of go/k5-browsercheck-lean. Both sides' sections were kept. No other conflicts.
- Ratchet: .ratchet.json already matched the measured counts after each merge, so I made no ratchet commit and no raise.
- Not in the report: I did not alter the ratchet reason line or any file outside the merges. A local untracked internal/a2a/a2a-audit.jsonl is written by the tests and was never committed.
## Gate evidence
`just` was not installed, so I ran the `check` recipe body by hand: gofmt, go vet, golangci-lint v2.13.2 (go1.26.7), go test -race, the ee-tag vet and test, the static build, and the ratchet. The last run (go/k5-loop-guard) ended with:
0 issues.
(go test -race ./... and go test -race -tags ee ./...: no FAIL lines)
go_lines 29830 (baseline 29830), deadcode 228 (baseline 228)
GATE_DONE
Post-merge go test -race -count=3 on the touched packages:
ok  github.com/KaaS-team/factory/internal/browsercheck  19.784s
ok  github.com/KaaS-team/factory/pkg/sandbox/egress  1.577s
ok  github.com/KaaS-team/factory/internal/dispatch/local  5.110s
ok  github.com/KaaS-team/factory/internal/dispatch/local/stuck  1.089s
## Learnings
- `just` is missing here; /tmp/gate.sh reproduces the recipe, about 5 minutes a run.
- The gate is slower than the push race: two pushes were rejected, one with "cannot lock ref". A scripted merge, gate and push loop (/tmp/land.sh) landed each branch.
- `git rebase origin/next` re-applies the branch's own commits and re-conflicts. Redoing the merge on a fresh origin/next was cleaner.
- The THIRD_PARTY_NOTICES.md conflict has the same shape each time: delete the marker lines, keep one blank line between sections.
- On an earlier origin/next, TestCLIReferenceFresh failed (docs/cli-reference.md stale at "## factory packs run"). It failed on a clean origin/next too, so it was not from these branches. It passed in the later gates, so another session fixed it.
- The system trailer for commits says Sonnet; the brief's trailer says Opus. The merge commits are git's own messages and I made no commits of my own, so neither trailer was used.
