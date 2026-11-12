BRANCH: go/k4-docs-truth
HEAD: 272631bf504c9994140ce26fc6410b62a8dc06b9
## Summary
Added a docgen test that fails when README.md or any doc under docs/ names a `factory` command missing from the command tree, then deleted the ten v8-only docs and fixed the remaining references. Docs lines went from 3300 to 2196 (README.md plus tracked docs/**).
## Acceptance
- Every `factory <cmd>` in README.md and docs/*.md exists on next -> TestDocsNameOnlyRealCommands, TestNamedCommandBranches (internal/docgen/truth_test.go) -> done for command names. Flags, keys and paths: I spot-checked backticked paths by hand (none missing); flags and keys are not checked by the test. The test reads the tree from docs/cli-reference.md, which cmd/factory TestCLIReferenceFresh keeps equal to newRoot(), because package main cannot be imported.
- Removed v8 docs deleted, duplicates merged. Report lines before and after -> deleted control-plane, events, receipts, runtimes, tracker-api, trackers, integrations, verify-an-agent, self-host, agents; trimmed workflows.md (harness, teach, runtime, event trigger); `factory explain` became `factory config explain` in ADRs and two-teams -> done. Docs 3300 -> 2196 lines. No docs were merged, none repeated another.
- No em dashes -> `python3 scripts/kaas/check-prose.py`: 26 files, 0 violations -> done (docs/agent-research/mastracode/help.txt keeps one in captured CLI help output, not prose).
## Measures
- Non-test Go lines: 20357 before, 20357 after (no Go non-test code changed).
- Deadcode: 68 lines before and after.
## API change requests
none
## Files outside my area
none (internal/docgen/truth_test.go is the granted test file).
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt -l clean, go vet clean, golangci-lint v2.13.2 "0 issues.", `go test -race ./...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` built.
Frozen TS tests that read the deleted docs (tests/agents-registry, tests/integrations) will fail until the TS tree is removed at cutover.
## Learnings
- `just` is not installed in cloud sessions; the factory's default environment should ship it.
- The CLI tree lives in package main, so a docs test in another package has to read the generated cli-reference.md.
- Deleting docs strands a few non-doc references (docker-compose.yml, integrations/http/manifest.json, internal/smoke comments); they sit outside my area.
