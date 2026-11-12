BRANCH: go/ghapp-update
HEAD: 15f6910d6b5a04f6661dc395a1f05f1035939b2d
## Summary
Added `internal/githubauth` (App JWT and cached installation token) and `internal/selfupdate` (Check, Apply, GitHub release source), both written fresh with the standard library only. machinist's githubauth has no JWT code and its updater is replaced by a smaller design that fits the brief's interface, so nothing was copied and no notices entry was needed.
## Acceptance
- JWT claims and RS256 signature verify -> TestJWTClaimsAndSignature -> done
- Token cached, refreshed only inside 5-minute window -> TestTokenCacheRefreshWindow -> done
- Refuses sha256 mismatch, old binary kept -> TestApplyRefusesAndKeepsOldBinary (sha256 mismatch row) -> done
- Apply replaces via same-directory rename -> TestApplyReplacesBinary, TestApplyRenamesInSameDirectory -> done
- No test touches the network -> httptest.Server on localhost and fakes only -> done
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt -l (clean), go vet ./... (clean), golangci-lint v2.13.2 on my two packages (0 issues), go test -race ./... (all ok), CGO_ENABLED=0 go build ./cmd/factory (BUILD_OK).
Lint ran only on my packages, not the whole repo.
## Learnings
- `just` missing in the cloud image; the factory image should install it.
- I wrote code and tests together, then proved the two key tests bite by mutation (refresh window, checksum guard) rather than watching each fail first. Both mutations went red.
- Brief says "no network" but the lint tool fetch via `go run` needs it; pre-install golangci-lint.
- Key is read by file path or env var name (KeyFromFile, KeyFromEnv); no CLI wiring was added since cmd/ is outside my area.
