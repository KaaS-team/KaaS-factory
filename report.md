BRANCH: go/gate-tail
HEAD: 90b672d464f98647c25e0d39a8d6530299d27e39
## Summary
`gate.Result` now has `Tail`: the last 60 lines (at most 8 KB) of combined output with token-shaped lines replaced by `[redacted]`, set for pass, fail, missing-line and timeout. The e2e harness reads `Tail` and the `.factory-gate.log` side file is gone.
## Acceptance
- Pass, fail, missing-line and timeout each set `Tail` -> TestRunTailAlwaysSet -> done
- 10,000 lines keep the last 60 and stay under 8 KB -> TestRunTailKeepsLast60LinesUnder8KB (plus TestRunTailByteCap for the byte cap) -> done
- Each token shape is redacted -> TestRunTailRedactsTokens (ghp, github_pat, sk, xoxb, xoxp, AKIA, plus a no-false-positive row) -> done
- e2e passes without the side log -> go test ./internal/e2e (gates.sh no longer writes a log; the needs-human comment test still sees `missingSymbol`) -> done
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is not installed; ran the recipe bodies by hand.
test -z "$(gofmt -l .)" -> clean; go vet ./... -> clean
golangci-lint v2.13.2 (GOTOOLCHAIN=go1.26.7): `0 issues.`
go test -race ./... -> all packages ok, no failures
CGO_ENABLED=0 go build ./cmd/factory -> ok (output went to /tmp, nothing left in the tree)
Bite check: raising the byte cap to 80 KB and disabling redaction made TestRunTailByteCap and TestRunTailRedactsTokens fail; reverted.
## Learnings
- Redaction matches token shapes with length floors, not bare prefixes: `sk-` alone would redact "task-list". The ticket's prefix list should say shapes.
- Run's buffer was sized by TailBytes (2000), too small for 60 lines; it now reads a 64 KB buffer and Raw is trimmed to TailBytes, so Raw keeps its old size.
- Lint needed a background run plus a file; it finished inside the timeout once modules were cached.
