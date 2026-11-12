BRANCH: go/k8-agent-token
HEAD: 16693d3710686ab7f333ab40b3b1e15fd396501c
## Summary
Added `ee/identity` (build tag `ee`): an HMAC-signed per-run agent token carrying only agent, run, tenant, delegator, jti and expiry, with a TTL revoke list and ledger events on mint and revoke. Authority is asked of a `Gate` interface on every `Authorize` call. Not wired into `cmd/factory` (outside my area), so it is unreachable from the binary until that edit lands.
## Acceptance
- Token revocation takes effect on next side effect via TTL blocklist -> TestRevokeTakesEffectOnNextAuthorize, TestBlocklistEntryDropsAfterExpiry -> done
- Only human or operator may mint; an agent token cannot mint another -> TestMintPrincipals, TestRevokeRefusesAgent -> done
- Mint and revoke emit ledger events -> TestRevokeTakesEffectOnNextAuthorize, TestLedgerFailureFailsOperation (a failed ledger write fails the operation) -> done
- Identity only, no scopes; authority live -> TestTokenCarriesNoScopes, TestAuthorizeAsksGateEveryCall -> done
- Bite-check: each rule was broken once and its test went red (agent may mint, revocation ignored, revoke no-op, token grants authority, no sweep, scope claim added, mint ignores ledger error).
## API change requests
- Wire `identity.Issuer` in `cmd/factory/ee.go` (ee build), and adapt the real ledger and the CEL gate to the `identity.Ledger` and `identity.Gate` interfaces. I could not find a CEL gate or an `api` ledger port in this repo, so both are local narrow interfaces.
## Files outside my area
none. I did not port kora's jti_blocklist (about 20 lines of our own code instead), so there is no notice entry. Ticket draft 1 (SCIM) and 3 (credential broker) are other sessions' work.
## Gate evidence
`just` is not installed, so I ran its recipe bodies by hand: gofmt clean; `go vet ./...` and `-tags ee` clean; `go test -race ./...` and `-tags ee` all ok; golangci-lint v2.13.2 on ee/identity with the ee tag: "0 issues."; static build ok. The full-repo lint was not run.
Measures: non-test Go lines 21276 before, 21488 after (the after count includes untracked files and picked up my 212-line file). Deadcode after: 70 lines without the ee tag, so it does not see the new package; no before count taken.
## Learnings
- `just` missing in cloud sessions; the recipes need to be a script. 
- The deadcode run exceeds the 2 minute tool timeout; run it in the background.
- A bite-check by sed can produce a compile error that looks like a failure; check that the mutant compiles.
