BRANCH: go/k3f-rest
HEAD: ccc9c6b74a1d5bc221026e6b3c6acc044f3cfd6f
## Summary
Deleted the unreached logs Local tail, pick routing and packs upstreams code, wired a new `factory shadow` command to shadow.Summary, and moved test-only code into test files. Non-test Go went from 20032 to 19586 lines and deadcode from 231 to 214 findings; the full gate was green on the tree before a final revert of an unrelated linear edit, which was not re-run through `just check`.
## Acceptance
- Each listed function is reached or deleted, fates below -> TestShadowCommandSummarizesWhatTheWriterRecorded, TestShadowCommandIsMounted, existing suites -> done
  - config.Describe: kept, docgen regenerates docs/config.md in a test (TestConfig docs freshness). config.Keys: moved into layering_test.go (test helper).
  - conformance na, tc, withAlso, Rows17, Items18: checklist.go moved to checklist_items_test.go (the package is a test suite).
  - dashboard.routes: now a method used by Handler to register routes; the no-write-routes test reads the same table.
  - shadow.Summary and tally.describe: wired through the new `shadow.NewCommand`, mounted in cmd/factory/main.go as `factory shadow`.
  - docgen CLI, walk, Config: kept, tests (clidoc_test, docgen_test) check docs/cli-reference.md and docs/config.md.
  - eval WithRunner, WithNow: kept as test seams. Not wired: `factory eval` still answers "no agent runner configured" in the real binary.
  - logs Local.Poll, localEvent, LocalFactory: deleted with tests. The local dispatcher writes no output file to tail. StoreLookup deleted; its test uses st.LatestSession.
  - packs FromUpstreams, kindOfPath: deleted with upstreams.json and tests (a one-off blueprint converter, no command).
  - pick LocalOnly, RefillRouted: deleted with route.go and tests. reconcile never called them. The workflow-file routing rule (#635) is no longer implemented anywhere.
  - provenance Check, Headers: kept, they are the gate test's code.
  - agentrun NewLocal, NewRoutines: kept, public API, existing tests in pkg/agentrun call them.
- Non-test lines go down -> before/after per package: logs 482->353, pick 210->115, packs 705->643, conformance 166->0, mcp 349->342, store 504->497, dashboard 260->262, shadow 246->272 (new command); total 20032->19586 -> done
- No behaviour change -> existing tests unchanged apart from deleted ones -> done
- Shrinking tui.go and linear.go by removing duplication -> blocked/not done (found no real duplication; my one linear helper added lines so I reverted it)
## API change requests
None.
## Files outside my area
- cmd/factory/main.go: one import and one `shadow.NewCommand()` in AddCommand.
- cmd/factory/main_test.go: TestShadowCommandIsMounted.
- docs/cli-reference.md: regenerated (UPDATE_GOLDEN=1) for the new command.
## Gate evidence
Run by hand because `just` is missing: gofmt clean, `go vet ./...` clean, `go test -race ./...` all ok, golangci-lint v2.13.2 "0 issues.", static build exit 0. Ran before the final linear revert, which restores origin/next content.
## Learnings
- deadcode must run under GOTOOLCHAIN=go1.26.7, else it fails on the go1.24 build.
- A just-wired command regenerates docs/cli-reference.md, which is outside every area; the brief should grant it.
- eval has no real runner and local sessions have no log file: both need core or dispatch work, not my area.
- Tests were not given a mutation proof for the dashboard routes or the mcp/store helper merge; the shadow command test was broken once and went red.
