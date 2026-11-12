BRANCH: go/k5-local-auth
HEAD: 5bbb1c0c06467ad1792e25f0b9fbd651998c13ee
## Summary
Added bearer auth (password or 30-day HMAC session token derived from the password, constant-time compare) and a loopback-only address helper to internal/dispatch/local, ported from opencode auth.ts. The local package has no HTTP endpoint today, so nothing wires it in and the auth is unreachable from cmd/factory until an endpoint exists.
## Acceptance
- Rotating the password invalidates old tokens -> TestRotatingPasswordInvalidatesTokens -> done
- Unauthenticated request returns 401 -> TestAuthMiddleware (no credentials, wrong password, non-bearer rows) -> done
- No token accepted in a query string -> TestAuthMiddleware (token and password in query rows) -> done
- Loopback bind by default -> TestLoopbackAddr -> done as a helper only; no listener exists to bind
- Bite-check: reverted each fix once (key derivation, query fallback, expiry, 401 gate, loopback check); the matching tests went red each time.
- Wiring into cmd/factory -> blocked (no dispatcher endpoint exists; cmd/ is outside my area)
- Tickets 1 and 3 belong to other sessions.
## API change requests
None. Whoever adds the dispatcher HTTP server should wrap its handler with (*local.Auth).Middleware, listen on local.LoopbackAddr(addr), and supply the password (env or file).
## Files outside my area
- THIRD_PARTY_NOTICES.md: section for the ported file (provenance test requires it).
## Gate evidence
just is missing; ran the recipe bodies by hand with GOTOOLCHAIN=go1.26.7: gofmt, go vet, golangci-lint (0 issues), go test -race ./..., CGO_ENABLED=0 go build ./cmd/factory.
ok  	github.com/KaaS-team/factory/pkg/agentrun	1.042s
ok  	github.com/KaaS-team/factory/pkg/sandbox	1.280s
GATE-OK
Measures: non-test Go lines 20357 before, 20444 after (+87). Deadcode lines 73 before, 82 after (the 7 new auth.go functions are unreachable until wired; the count was 75 when measured before the lint fix).
## Learnings
- No dispatcher endpoint exists in internal/dispatch/local; the ticket should name the package that has it or say to build it.
- staticcheck QF1001 rejects negated groups; write the De Morgan form first.
- The full gate takes over 5 minutes; run it in the background from the start.
