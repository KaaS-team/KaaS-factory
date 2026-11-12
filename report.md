TICKET: m3-gate-tooling
NEXT: b137e5883bf281ae6614842ef5b498386835adc5
## Fixed
- PATH golangci-lint v2.5.0 (Go 1.25) preferred over the pinned v2.13.2 -> b940b0d, TestLintPicksPinned
- No fallback for hosts without `just` -> b940b0d, gate.sh + TestStepsMatchJustfile
- justfile pin could drift from CI -> b940b0d, TestLintPinMatchesCI (wired via go test in `check`)
## Bite checks
- TestLintPinMatchesCI -> justfile lint_version v2.13.3 differs from .github/workflows/go.yml v2.13.2
- TestLintPicksPinned/older_binary -> got "LINT run ./...", want "GO go1.26.7 run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./..."
- TestStepsMatchJustfile -> justfile check steps [fmt vet lint test build ratchet] differ from gate.sh STEPS [fmt lint vet test build ratchet]
## Not fixed
- `just` missing on this host: gate run via ./gate.sh (the check recipe's steps). Not installed.
- Race count=3 run only on tools/gate (the only package touched); passed.
- Left out: no changes to .github/, TS tree, or other recipes (fmt/vet/test/build/ratchet duplicated in gate.sh, pinned by the step-list test only).
## Gate evidence
ok  	github.com/KaaS-team/factory/tools/gate	1.029s
ok  	github.com/KaaS-team/factory/tools/ratchet	(cached)
go_lines 30383 (baseline 30383), deadcode 228 (baseline 228)
exit 0 (./gate.sh, after rebase onto 8a65c8d)
## Learnings
- Go 1.24 host needs GOTOOLCHAIN=auto to fetch 1.26.
- Full gate takes ~4.5 min; run it in the background.
- git checkout of a file I had edited reverted my edit while bite-checking; use a copy to restore.
