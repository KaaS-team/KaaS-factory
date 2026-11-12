BRANCH: go/ee
HEAD: f2a12721051ae89a0126e80086e7273c56abbe16
## Summary
Ported enterprise OIDC sign-in, SCIM 2.0 Users and Groups, and a YAML policy check into `ee/sso`, `ee/scim` and `ee/policy`, all behind `//go:build ee`. SAML is left out this round, as the ticket said.
## Acceptance
- OIDC login redirect and callback against a fake provider yield a session with email and groups -> ee/sso TestLoginAndCallbackYieldSession, TestCallbackRefusals, TestAlgNoneRefused, TestNewOIDCValidates -> done
- SCIM create, filter by userName, deactivate by PATCH, delete, with TS schemas -> ee/scim TestUserLifecycle, TestAuthAndValidation, TestGroups -> done
- Policy table: role allowed, role denied, repo glob miss, spend ceiling hit, unknown action denied, each with a rule id -> ee/policy TestCheckTable, TestParseRejects, TestDenyBeatsAllowRegardlessOfOrder -> done
- Building without -tags ee compiles none of these files -> ee/notag_test.go TestNoEEFilesWithoutTag (runs `go list`) -> done
Left out: SAML. `Check` is not yet called from Dispatch, Merge or SetPhase because those live in files outside my area (see API change requests). SCIM has no persistent Store (only MemoryStore), no audit log, and no link from SCIM users to plane membership; the TS plane did that through its own store.
## API change requests
- The core should call `policy.Check(ctx, Actor, Action, Resource)` before Dispatch, Merge and SetPhase. That needs a narrow `Checker` interface in the caller, wired in `cmd/`, and an `ee` build-tag file that supplies the engine. I did not touch `internal/api/` or `cmd/`.
## Files outside my area
- go.mod, go.sum: added go-oidc/v3 v3.14.1 and oauth2 v0.30.0 (named by the ticket). `go mod tidy` also pulled go-jose/v4 and x/crypto as indirect deps and raised the indirect testify from v1.8.4 to v1.10.0.
- ee/notag_test.go: new untagged test file in `ee/` (the package-level check for the no-tag acceptance line). No TS file touched.
- The supervisor must add a `test-ee` recipe to the justfile: `go test -race -tags ee ./ee/...` (and ideally `golangci-lint run --build-tags ee ./ee/...`). I added nothing to the justfile.
## Gate evidence
`just` is not installed here, so I ran the recipe bodies by hand with `GOTOOLCHAIN=go1.26.7` for lint: gofmt -l (clean), go vet ./... and go vet -tags ee ./ee/... (clean), golangci-lint run ./... (`0 issues.`), golangci-lint run --build-tags ee ./ee/... (`0 issues.`), go test -race ./... (all ok, including internal/provenance), go test -race -tags ee ./ee/... (ok policy, scim, sso), CGO_ENABLED=0 go build ./cmd/factory (ok).
## Learnings
- The brief says every file starts with `//go:build ee` and also carries an SPDX line; the build line must come first, then a blank line, then the SPDX comment. State that order in the brief.
- `just` is missing in the cloud image; the recipe bodies in the brief's setup step saved time.
- A Go-test mutation check (revert the code, watch the test fail) was not run; red was seen only as a compile failure before the code existed.
