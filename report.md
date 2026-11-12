BRANCH: go/k4-ee-mount
HEAD: ceda3265117205411b1b5adbee93f193a6a3f783
## Summary
The ee build now mounts `policy` and `scim` commands and, when FACTORY_POLICY names a rules file, a policy guard in front of dispatch and retry with one JSON audit line per decision. The default build has no ee symbols. SSO (OIDC/SAML) is not mounted.
## Acceptance
- Default build has no ee symbols; `-tags ee` lists the ee commands in --help -> TestEEMountedOnlyWithTag (go list -deps), TestEECommandsListed (ee tag) -> done
- Policy table test: allow, deny, missing rule, deny-over-allow -> ee/policy TestCheckTable, TestDenyBeatsAllowRegardlessOfOrder (already on next), plus TestGuardChecksBeforeActing (missing rule denies, one audit line per decision) -> done
- `just check` also builds and tests -tags ee -> justfile test recipe: `go vet -tags ee ./... && go test -race -tags ee ./...` -> done
## Measures
- Non-test Go lines (the given command, untracked files included): 20357 before, 20554 after (+197; ee/policy/guard.go and cmd/factory ee files; nothing deleted, nothing was made redundant).
- Deadcode default build: 68 before, 68 after. With -tags ee: 84, all 16 are the existing ee/sso functions, which no command mounts. Everything I added is reachable from cmd/factory.
## API change requests
none
## Files outside my area
- cmd/factory/main.go: one line, `addEE(root)` in newRoot (nothing else can call the per-tag file).
- cmd/factory/clidoc_test.go: skips the golden CLI reference under -tags ee, since the reference documents the default build.
- justfile: the one test-recipe line granted by the ticket.
## Gate evidence
`just` is not installed; I ran the recipe bodies by hand with GOTOOLCHAIN=go1.26.7: gofmt clean, `go vet ./...` and `-tags ee`, golangci-lint 0 issues (default and `--build-tags ee`), `go test -race ./...` and `-tags ee` with no failures, then
0 issues.
0 issues.
BUILD_OK
## Learnings
- No `just` in the cloud image; the gate had to be run by hand and exceeded the 120s tool timeout (run it in the background).
- The ee tree already had Go ports of policy, scim and sso; the ticket's "port from ts-final" was unneeded. Audit line and the mount were the real gaps.
- A golden doc test over the whole command tree breaks under any build tag that adds commands; the test needs to know the tag.
- SSO is still unmounted: it needs config design (IdP settings, session store), left for its own ticket.
- Wrapping newControl inside addEE stacks a wrapper per newRoot call (tests only; production calls once).
