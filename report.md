BRANCH: go/k8-cred-broker
HEAD: cbbc172f9610b4ace3bb1180941873e1297ee24c
## Summary
New `internal/dispatch/broker/`: Connector/Adapter/Policy interfaces (Type, Actions, Open, Classify, Mint with ExpiresAt), a file-backed secret source, one GitHub adapter, a fake in `brokertest`, and `NOTE.md` with measured cost. Nothing is reachable from `cmd/factory` yet (see API change requests), so the 13 new deadcode lines are all this package.
## Acceptance
- One adapter (GitHub) behind the interface -> TestGitHubClassify, TestGitHubMintExpiry, TestMintRefusesUnlistedAction -> done
- Gate checks the classified action -> TestGateChecksClassifiedAction, TestSecretNeverInErrors -> done
- File-backed implementation -> TestFileSource -> done
- Written note with measured RAM and latency -> NOTE.md, BenchmarkRequest, BenchmarkRequestFileSource, TestBrokerHeapStaysSmall -> done (0.4 us in memory, 5.9 us with file read; heap under 1 KiB per broker)
- "Nothing you add may be unreachable from cmd/factory" -> blocked (wiring needs edits to `cmd/` and dispatch/local, outside my area)
- Bite-checks, each reverted once and its test went red: gate skipped (TestGateChecksClassifiedAction, TestSecretNeverInErrors), pr.update loosened (TestGitHubClassify, after adding a row it lacked), mint any verb (TestMintRefusesUnlistedAction), file perm check (TestFileSource), expiry (TestGitHubMintExpiry), adapter lookup (TestGateChecksClassifiedAction).
- Not done: tests were written before code but I did not run them against stubs; they failed only as a compile error first. No CEL gate wiring, no installation-token narrowing, no kora jti blocklist (other ticket).
## API change requests
- Wire the broker: a transport for sessions to reach it, `Policy` bound to the CEL gate, and `local.childEnv` dropping the GitHub token once the broker is on. Needs `cmd/` and `internal/dispatch/local`.
## Files outside my area
none
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt clean, go vet clean, golangci-lint v2.13.2 "0 issues.", `go test -race ./...` no failures, `CGO_ENABLED=0 go build ./cmd/factory` BUILD_OK.
Measures: non-test Go lines 21276 -> 21526 (+250). Deadcode lines 70 (inferred: 83 minus 13 broker) -> 83.
## Learnings
- `just` is absent in cloud sessions; the brief's hand-run list works but the race run exceeds 120 s, so run it in the background.
- The "unreachable from cmd/factory" rule conflicts with "stay inside the area" for any new port; the brief should name the wiring ticket.
- Kora's adapter.go was not cloned (network scope); shapes came from the ticket text.
