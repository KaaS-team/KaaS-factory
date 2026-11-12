BRANCH: go/ee-saml
HEAD: 645ebeb69b08b6326d48ef96a0879ab5edd0b5d0
## Summary
Added SAML 2.0 SP-initiated sign-in in `ee/sso/saml.go` (build tag `ee`): SP metadata, login redirect and ACS, producing the same `Session` as OIDC. It uses `github.com/crewjam/saml` v0.6.3, which passed vetting except for the advisory lookup (see Learnings).
## Acceptance
- Login round trip against an in-test IdP (generated keys) yields a Session with email and groups -> TestSAMLRoundTrip (also TestSAMLMetadata) -> done
- Unsigned, wrong-key, expired and replayed assertions are each refused (table test) -> TestSAMLRefusals (rows: unsigned, wrong key, expired, wrong relay state, garbage, replayed, no cookie) -> done
- Building without `-tags ee` compiles none of it -> ee TestNoEEFilesWithoutTag passes -> done
Library vetting: crewjam/saml v0.6.3 is the latest release (2026-11-08), BSD-2-Clause (LICENSE read from the v0.6.3 tag), go directive 1.25.0 so go.mod stays at 1.26.0. Open security advisories could NOT be checked: GitHub API, osv.dev and vuln.go.dev are blocked from this session. Please run govulncheck or check the repo's advisories page before merge. go.mod also gains etree, goxmldsig, clockwork (direct), and x/crypto moves 0.36.0 to 0.55.0.
Bite proof: removing `ReplayCache` from the SP made the replayed row fail (second use returned 204). Each other refusal row differs from the passing round trip by one change, so it cannot pass for another reason.
Design notes: replay cache is in memory, per process (the IDs are kept until their validity ends); a multi-node deployment needs a shared one. The flow cookie is SameSite=None; Secure because the IdP posts cross-site. SHA-1 signatures are rejected. Email comes from the "email" attribute, else an email-shaped NameID; groups from the "groups" attribute; both names are configurable.
## API change requests
none
## Files outside my area
- go.mod, go.sum: the dependency the ticket names.
- ee/sso/oidc.go: one doc-comment line said "SAML is not supported"; now points to saml.go.
## Gate evidence
`just` is missing, so the recipe bodies were run by hand: `test -z "$(gofmt -l .)"`, `go vet ./...`, golangci-lint v2.13.2 (GOTOOLCHAIN=go1.26.7) with and without `--build-tags ee`: "0 issues.", `go test -race ./...` all ok, `go test -race -tags ee ./ee/...` ok, `CGO_ENABLED=0 go build ./cmd/factory` ok, binary removed.
ok  	github.com/KaaS-team/factory/ee/sso	3.754s
## Learnings
- Lint without `--build-tags ee` skips ee files, so it missed two issues in my test; the gate should lint ee with the tag.
- The library hides why an assertion failed ("Authentication failed"), so refusal rows prove cause only by differing from the passing case by one change.
- The IdP in crewjam/saml panics on error with a nil Logger; set `Logger` in test IdPs.
- Advisory databases are unreachable in the cloud image; the vetting step needs a local govulncheck DB or an allowed host.
