BRANCH: go/packs-cmd
HEAD: 822195f310d7eb048423afdf094074496da594c8
## Summary
Added `packs.NewAddCommand()` and `packs.NewPacksCommand()` (`list`, `verify`) in `internal/packs/command.go`. `add` pins a file in `factory.lock` and caches its content under `.factory/cache/files/<owner>/<repo>/<sha>/<path>`, which `verify` re-hashes.
## Acceptance
- add against a local fake upstream writes the expected lock (golden) -> TestAddWritesGoldenLock (also TestAddAtRefResolvesToSha, TestAddKindAndArgs) -> done
- AGPL and CC-BY-SA refused with the licence named -> TestAddRefusesLicences -> done
- Second add leaves the lock byte-identical -> TestAddTwiceLeavesLockByteIdentical -> done
- verify passes on a fresh cache, fails naming the file after one byte changes -> TestPacksVerify (also TestPacksListTextAndJSON, TestPacksListEmpty) -> done
## API change requests
none
## Files outside my area
none (command.go, command_test.go, testdata/add.lock.golden, all in internal/packs)
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt (`test -z "$(gofmt -l .)"`), go vet, golangci-lint v2.13.2 ("0 issues."), `go test -race ./...` (every package ok), `CGO_ENABLED=0 go build ./cmd/factory` (binary removed).
## Learnings
- Tests were written first and failed to compile (no newAddCommand). Bite proofs: breaking verify's hash compare turned TestPacksVerify red; replacing ReadLock with an empty lock turned TestAddTwice red. My first idempotence mutation did not bite (it only changed the write path), so I replaced it.
- Design choices: id is the SKILL.md directory name, else the file stem; short hash is the first 12 hex of sha256; the kind is inferred from a skills/agents/workflows/checks path segment, or set with --kind. `--root` sets the repo root, default ".". A tag or branch after `@` is resolved to a sha first. Git bare repos live in `.factory/cache/repos`.
- Warm the golangci-lint download in the background at the start of the run.
