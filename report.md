BRANCH: go/k11-store-crypt
HEAD: daf52c70c7ff63fa12685efabc3347b4ad5b5cba
## Summary
Added `internal/store/crypt` (AES-GCM `Encrypted` store wrapper with the `+aesgcm` type tag, key-file loader, memory and SQLite stores, keep-latest prune) and `internal/store/conformance` (one suite run on memory, SQLite, and both encrypted). It is not reachable from `cmd/factory`, so the deadcode ratchet fails (see Gate evidence).
## Acceptance
- Plain and encrypted rows both load -> TestPlainAndEncryptedRowsBothLoad, TestEncryptedStoresCiphertextWithTag, TestDecryptFailures -> done
- Prune keeps latest per thread -> conformance case "prune keeps latest per thread" -> done
- Same suite passes on SQLite and an in-memory store -> TestConformance (memory, sqlite, encrypted memory, encrypted sqlite) -> done
- Key from a keyfile path, never a command-line value -> TestLoadKey (raw, hex, short, group-readable, missing) -> done (the loader takes a path; no CLI flag was added)
- Nothing unreachable from cmd/factory -> blocked (cmd/ is outside my area; no caller exists)
Bite-checks (each fix reverted once, its test went red): SQLite prune, memory prune, plain pass-through, encryption removed, AAD binding, key file permission check.
## API change requests
None to `internal/api`. Ticket 1 (checkpoints table in factory/graph) has not landed, so I defined a narrow `crypt.Store` interface (Put, Get, Latest, PruneKeepLatest). The graph store session should adopt it or wrap its table in it, and `cmd/factory` should load the key with `crypt.LoadKey` and wrap the store with `crypt.New`.
## Files outside my area
None.
## Gate evidence
`just` is not installed; ran the recipes by hand. gofmt clean, `go vet ./...` clean, golangci-lint on `./internal/store/...`: `0 issues.`, `go test -race ./internal/store/... ./internal/provenance/...` ok, full `go test ./...` ok. Not run: the full-repo lint, race run and ee-tag tests.
`go run ./tools/ratchet`: `go_lines 21418 (baseline 21418), deadcode 92 (baseline 68)` then `ratchet: deadcode 92 is above baseline 68`. This fails until the store is wired from cmd/factory.
Measures: non-test Go lines (cmd as given) 21418 before, 21787 after (+369). Deadcode with the pinned command: 70 before, 92 after (+22). The ratchet reports baseline 68 for the same count.
## Learnings
- Ratchet and "nothing unreachable" conflict with a library-only area; a brief that forbids touching cmd/ should name the wiring owner.
- No upstream file was copied (design port only), so there is no `// Ported from` header or notices section.
- The first deadcode and golangci-lint runs download many modules and exceed the 2 minute tool timeout; start them in the background.
