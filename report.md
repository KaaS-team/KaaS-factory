BRANCH: go/k9-scim
HEAD: 25a70174321f849638ca38000b55f232004d30b5
## Summary
ee/scim now serves SCIM 2.0 through elimity-com/scim@7363468 (a module dependency, nothing copied), with bearer tokens mapped to tenants, one audit event per call, PUT, discovery endpoints, full filters and paging. The hand-written handler (about 500 lines) was replaced by Store-backed library resource handlers.
## Acceptance
- ServiceProviderConfig, Schemas, ResourceTypes respond -> TestDiscoveryEndpoints -> done
- Users and Groups Create/Get/List/Replace/Patch/Delete backed by our store -> TestUserLifecycle, TestGroups, TestReplace -> done
- Bearer token auth plus tenant scoping -> TestAuthAndValidation, TestEmptyBearerRefused, TestTenantScoping -> done
- Conformance against Okta and Entra sample payloads -> TestIdPPayloads -> done (payloads written from the documented request shapes, not copied from the library's idp_test fixtures)
- Every call writes an audit event -> TestEveryCallIsAudited -> done (refused calls too, with empty tenant)
Bite-checks (each fix reverted once, named test went red): tenant check in users, groups, list and uniqueness (TestTenantScoping); audit call (TestEveryCallIsAudited); Entra "True" rewrite and member removal by filter and paging count and startIndex (TestIdPPayloads); PUT body handling (TestReplace); empty bearer (TestEmptyBearerRefused). Three first-draft tests survived (filter removal, empty bearer, page count); tests were strengthened and the mutants then died.
Already on base and kept: Store and MemoryStore, the email-only userName rule, group cleanup on user delete, the `factory scim` command, the no-tag and ee-import guards.
Left out: kora credential adapter and JTI blocklist rows (tickets 2 and 3 belong to other sessions). The two library behaviours that differ from the old handler: a body without "schemas" is a 400 (RFC 7643 requires it, IdPs always send it), and PUT on a collection path is 404 instead of 405.
## API change requests
None.
## Files outside my area
- go.mod, go.sum: the elimity-com/scim dependency the ticket names (adds q-uint/xsd-datetime, scim2/filter-parser, q-uint/parser).
- Wiring not done: cmd/factory/ee.go still calls scim.NewHandler(store, token), which now audits to stderr as JSON lines and uses tenant "default". Multi-tenant tokens and a ledger sink need scim.NewTenantHandler from cmd; that is a follow-up in cmd/.
- THIRD_PARTY_NOTICES.md not edited: no file was copied, the library is a go.mod dependency (MIT).
## Measures
- Non-test Go lines (git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l): before 21276, after 21341 (+65). ee/scim itself grew because it gained tenancy, audit, PUT and the entraBools shim; the library adds no lines to the count.
- deadcode (default tags): before 70, after 70. With -tags ee, 0 entries under ee/scim.
## Gate evidence
just is not installed, so the recipe bodies ran by hand: gofmt -l . (empty), go vet ./... and go vet -tags ee ./... (ok), golangci-lint v2.13.2 on ./... and on ee and cmd with -tags ee (0 issues), go test -race ./... (all ok), go test -race -tags ee ./ee/... ./cmd/... (all ok), CGO_ENABLED=0 go build ./cmd/factory with and without -tags ee (ok).
## Learnings
- just is missing in cloud sessions; the brief's fallback list worked.
- The library's schema.SetAllowStringValues is an unsynchronized global for Entra's "True"; rewriting the PATCH body locally avoids it and stays race-free.
- go test without -tags ee compiles none of ee/scim; run both tag sets or the work goes untested.
- git show of the brief and the gate both need GOTOOLCHAIN=auto set before the first go command.
