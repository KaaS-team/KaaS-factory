BRANCH: go/observe-github
HEAD: c3afe48fdb2f80cbae706fa1188a9cb1fbac75c1
## Summary
Added `internal/observe/ghsource` with `New(client, owner, repo, base)` implementing `observe.Source` on go-github v79 (already in go.mod), plus a typed `RateLimitedError`. One commit, pushed.
## Acceptance
- `var _ observe.Source = (*Source)(nil)` -> compile-time assertion in source.go and source_test.go -> done
- Branch present/missing, PR found/missing, DiffFiles over two pages -> TestBranch, TestPullRequest, TestDiffFilesTwoPages (httptest.Server) -> done
- Checks roll-up (all pass, one pending, one failed, legacy failure only, nothing reported) -> TestChecksRollup (also a legacy-pending row) -> done
- Rate-limited 403 returns typed error with reset time -> TestRateLimited -> done
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand. gofmt (`test -z "$(gofmt -l .)"`), `go vet ./...`, golangci-lint v2.13.2 on go1.26.7 ("0 issues."), `go test -race ./...` (all packages ok, last line `ok github.com/KaaS-team/factory/packs`) and `CGO_ENABLED=0 go build` (BUILD_OK, binary written to /tmp, not the tree) all passed.
## Learnings
- GetBranch follows redirects by hand and skips go-github's rate-limit check, so a 403 comes back as a plain error. I read the rate headers from the response myself.
- Tests were written first and failed to compile (no code). I proved the roll-up test bites by breaking the failure case once: two rows went red. I reverted the break.
- The first mutation attempts did not compile or did not hit a row, so the bite check cost three tries. A one-line `case x && false:` is the quick form.
- The Go 1.26.7 toolchain download for lint was slow, so warm it in the background at the start.
- The check-run roll-up treats failure above pending, which the ticket did not spell out. It reads "any failure is fail".
