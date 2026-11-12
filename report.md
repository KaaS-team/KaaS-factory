TICKET: m1-a
NEXT: 72f2357fc69da7cb11e73733cf827d9ef78c0773
## Merged
- go/k6-depup-rules -> 998f4ac
- go/k6-lintdelta -> 0258365
- go/k6-price -> d0d31b9
- go/k6-replay -> fb9ba57
## Skipped
- go/k6-plan-files -> all 6 push tries rejected by concurrent pushes to next (the first run also hit TestCLIReferenceFresh, which was red on origin/next itself until another session fixed it). Merge was clean, its gate was green, the diff reviewed clean. Needs a fresh run.
## Review notes
- k6-depup-rules: clean. Minor: a cron field like `*/2` in dom or dow is not treated as a star for the standard day-field OR rule.
- k6-lintdelta: clean. Command lints run an argv from config, no shell.
- k6-plan-files: clean. Stale() treats git exit codes other than 0 or 1 as errors, so a failed merge-tree is not read as "applies". Heads are SHAs from the tracker API.
- k6-price: Go code was added under scripts/price-refresh (the TS scripts tree); the branch's own content, left as is. price-refresh reads the upstream response with an unbounded io.ReadAll and interpolates the --sha flag into a fixed-host URL path; operator-run only, low risk. Its langfuse notice section collided with an existing section of the same heading, so I merged them into one section.
- k6-replay: clean. Recorder.save writes message data unscrubbed; Stabilize is applied only on comparison, so re-recording against live data can store secrets in a fixture.
## Gate evidence
go run ./tools/ratchet
go_lines 32028 (baseline 32028), deadcode 258 (baseline 258)
(just check exit 0: fmt, vet, lint, race tests incl. -tags ee, build, ratchet)
## Learnings
- Preinstalled /usr/local/bin/golangci-lint is v2.5.0 (go1.25) and fails on go 1.26; I moved it aside so just uses the pinned go run version.
- just was not installed; pip install just, then it ran as `just`.
- GOTOOLCHAIN=auto fetched go1.26 fine.
- Concurrent pushes cost 2-6 full gate runs per branch; merging origin/next into the local merge and re-running beats redoing from scratch.
- NOTICES.md conflicts on the same upstream heading (langfuse) need merging into one section, not both.
- Tests drop internal/a2a/a2a-audit.jsonl untracked; delete it before merging.
