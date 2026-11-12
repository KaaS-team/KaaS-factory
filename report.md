BRANCH: go/k5-egress-secrets
HEAD: e99de9102f1a76020b112cee8fd6f9a1cd1633ee
## Summary
New `pkg/sandbox/egress/`: allowOut/denyOut rules (allow wins, domain and wildcard, DNS servers), secret placeholders resolved by a local TLS-intercepting proxy only for listed hosts, a wildcard-depth gate, the ported token-name validator, and a streaming output masker ported from OpenHands. The package is not wired into `cmd/factory` (see API change requests), so deadcode lists all of it.
## Acceptance
- e2b #2: allowOut/denyOut, allow wins, domain and wildcard, dnsServers -> TestNetworkAllowed, TestNetworkValidate, TestDNSServersDefault, TestProxyAllowOutWinsOverDeny -> done
- e2b #2: secret placeholders resolved by a local proxy only for listed domains -> TestExpand, TestProxyInjectsTheRealValueOnlyForAnAllowedHostOverTLS, TestProxyWildcardHostGetsItsSecret -> done
- e2b #2: gate rejects wildcard transforms broader than a configured depth -> TestNewSecretsGate -> done
- e2b #2: token name validator ported from iam.ts with its test cases -> TestValidateTokenName -> done (upstream has no direct test for the validator; I wrote one row per clause of its doc comment)
- e2b #2: Apache-2.0 notice -> THIRD_PARTY_NOTICES.md `## e2b-dev/E2B@3e72be3`, provenance test green -> done
- microsandbox #3: agent env has only placeholders -> TestEnvOnlyCarriesPlaceholdersNamedInTheCommand -> done
- microsandbox #3: real value only for allowed hosts over TLS -> TestProxyInjectsTheRealValueOnlyForAnAllowedHostOverTLS, TestProxyHostileHostNeverReceivesAValue (cleartext case) -> done
- microsandbox #3: leak test with a hostile host fails closed -> TestProxyHostileHostNeverReceivesAValue, TestProxyEgressRulesFailClosedBeforeDialing -> done
- microsandbox #3: written design with go/no-go on a VM backend -> `pkg/sandbox/egress/doc.go` (no-go for now) -> done
- openhands #2: chunk-split secret masked across a boundary -> TestMaskerStream, TestMaskerNeverEmitsASecretByteBeforeItIsComplete (every split point) -> done
- openhands #2: secrets injected only when named in the command -> TestEnvOnlyCarriesPlaceholdersNamedInTheCommand -> done
- openhands #2: no secret value in logs or ledger -> TestSecretNeverPrintsItsValue (fmt verbs, slog JSON, json.Marshal, Secrets) -> done. No ledger code exists in my area, so only the types are covered.
- Left out: request bodies and URLs are not rewritten (headers only; a placeholder in a URL is refused). WebSocket upgrades inside intercepted TLS are refused. microsandbox #1/#2 and openhands #1/#3 are other sessions' tickets.
- Bite-check: reverted each fix once and the named tests went red for: allow-wins order, default-allow, wildcard label boundary, wildcard depth gate, per-host secret check, brace rule in the name validator, masker hold-back length, longest-first masker order, cleartext placeholder refusal, URL placeholder refusal, egress check, intercept-vs-tunnel choice, named-in-command rule.
## API change requests
- Wiring: nothing reaches `egress` from `cmd/factory`. Needs `pkg/sandbox` (or `internal/dispatch/local`) to start a `Proxy`, point the jailed env at it with `Secrets.Env`, trust `CA.PEM()`, restrict the jail's TCP connect to the proxy port, and pipe agent output through `Masker`. That touches files outside my area, so I did not do it.
## Files outside my area
- `THIRD_PARTY_NOTICES.md`: two sections (e2b-dev/E2B@3e72be3, OpenHands/software-agent-sdk@10be259), required by the provenance test.
## Gate evidence
`just` is not installed here, so I ran its recipe bodies by hand: gofmt (clean), `go vet ./...` (clean), golangci-lint v2.13.2 under go1.26.7: `0 issues.`, `go test -race ./...`: every package ok, none failed (last lines: `ok  	github.com/KaaS-team/factory/pkg/sandbox	1.254s` / `ok  	github.com/KaaS-team/factory/pkg/sandbox/egress	1.141s`), `CGO_ENABLED=0 go build ./cmd/factory`: BUILD_OK.
Measures: non-test Go lines 20357 before, 21169 after (+812, mostly the proxy and CA). Deadcode lines 68 before, 111 after (+43, all in `egress`, because it is unwired).
## Learnings
- `just` missing in the cloud image: install it in the setup script or the brief should say to run the recipe bodies.
- The repo is over its 8000-line budget before any ticket lands, so a brief that adds a package should name the call site to wire, or the "unreachable from cmd/factory" rule cannot be met inside the stated area.
- A mutation loop run from a subdirectory with `./pkg/...` paths reports "setup failed" for every case; run it from the package directory.
