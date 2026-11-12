BRANCH: go/k6-lintdelta
HEAD: fd0691c8126dd9fc5b764b56460010e8d773f3d8
## Summary
Added `internal/gate/lintdelta`: a Go design of the lint-delta edit gate (no upstream code copied, so no THIRD_PARTY_NOTICES section). `Check` lints the file before and after an edit, maps old errors through the edited line range, and rejects when the new file has an error the old one lacked, returning both numbered windows.
## Acceptance
- Fixture with a syntax-breaking edit is rejected -> TestCheck/"syntax-breaking edit is rejected" (asserts both windows are in the message) -> done
- Edit on an already-broken file passes if no new errors -> TestCheck rows "edit on already-broken file passes...", "insert above shifts...", "reworking the broken line..." (plus a row where a new error is still rejected) -> done
- Eval scorecard shows fewer failed-edit turns -> blocked (needs the eval harness, ticket 2, a different area, and a wired caller)
Bite-checks (each fix reverted once, TestCheck went red): line shift for errors below the edit, the pre-edit error set, the reject decision, the in-range wildcard (this one first survived; I added the "reworking the broken line" row, and it then failed).
## API change requests
None to `internal/api`. The package is not yet reachable from `cmd/factory`: wiring it as a hook on edit results needs an edit to `cmd/` or a dispatch/agent-preset file, outside my area. Deadcode will list `lintdelta` until a session that owns the caller imports `Check`, `GoSyntax` and `Command`.
## Files outside my area
None.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: `gofmt -l .` clean, `go vet ./...` clean, `go test -race ./...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` BUILD_OK. golangci-lint v2.13.2 on the new package: `0 issues.` I ran lint on my package only, not the whole repo. Deadcode was not run (not measured).
Non-test Go lines (excl. src/): before 20832, after 20997 (+165). Deadcode before and after: not measured. No Python linter is wired; `Command` is the generic hook (for example flake8 with a regexp), untested against a real flake8.
## Learnings
- Go 1.26.0 had to be downloaded under GOTOOLCHAIN=auto; the factory image should preinstall it.
- `just` was missing; the image should carry it or `just fast` should have a plain-shell twin.
- A ticket that adds a package without a wiring path in its area cannot meet "reachable from cmd/factory"; tickets should name the caller session.
