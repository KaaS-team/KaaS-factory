BRANCH: go/k6-plan-files
HEAD: 9ca098bae00d4dd66a45211b1470715b90ad821b
## Summary
Added a stale-diff precheck to the merge queue (a PR that no longer applies to the base goes back to its agent with the failing path) and a `## Uses` section parsed into `Ticket.UsesFiles` with a repo filter. Dispatch filtering and tree-sitter syntax validation are blocked (outside area, cgo).
## Acceptance
- Planner output includes a validated list of repo paths per ticket; paths not in the repo are dropped -> TestBodyUsesFiles, TestFilterUses -> done (parsing and filter exist; planner JSON output in plancmd is not changed, outside area)
- Dispatch loads only those paths when the field is set; fallback when empty; metric offered vs read -> TestUsesMetric -> blocked (dispatch is outside my area; only the metric line and the filter exist, nothing calls them yet)
- Before a ticket diff enters a batch, verify it applies to the current base -> TestPrecheckFilter, TestRunReturnsStalePRToAgent, TestGitConflictAndBaseMoved (Stale) -> done (git merge-tree, not a ConflictedPaths port)
- Tree-sitter syntax validation on changed files when grammars are available -> TestPrecheckFilter (syntax rows) -> blocked (no grammars: CGO_ENABLED=0). The Syntax interface is in place and skipped when nil.
- A failed check returns the ticket to the agent with the failing path, not to the queue -> TestRunReturnsStalePRToAgent, TestCoreQueueReturnsStaleTicketToRunning -> done
Bite-check: reverted the precheck call, the running-phase return, the --name-only flag, the exists filter and the UsesFiles wiring once each; the named tests went red each time.
Ticket #2 (repo map) left to the repomap session. No plandex code was copied, so no notices entry.
Measures: non-test Go lines 20357 -> 20577 (+220 counting everything not in src/ and tests); deadcode 68 -> 70 (FilterUses and UsesMetric have no caller yet).
## API change requests
None. Wanted: plancmd TicketJSON gets `uses_files`, and dispatch calls plan.FilterUses and logs plan.UsesMetric.
## Files outside my area
internal/mergeq/wire/git.go, wire.go, wire_test.go (inside mergeq, not the named precheck.go): Git.Stale and passing it as Deps.Applier. internal/mergeq/run.go, corequeue.go: Runner.Pre and Report.Returned.
## Gate evidence
just is missing; ran the recipe bodies by hand: gofmt -l ., go vet, golangci-lint v2.13.2, go test -race ./..., CGO_ENABLED=0 go build ./cmd/factory. All passed; last lines: "ok  github.com/KaaS-team/factory/pkg/sandbox 1.371s", "[exited with code 0]".
## Learnings
- just is not installed in cloud sessions; the factory default should install it or give a script.
- The first go command downloads the toolchain and modules, which pushes a full gate past the 120s foreground limit; run it in the background.
- Brief wording "Dispatch loads only those paths" is outside the area it grants; split dispatch work into its own ticket.
