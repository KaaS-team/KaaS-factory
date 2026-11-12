BRANCH: go/k8-plan-preset
HEAD: 7752a55cf684641c7a840d6c8d959ba8c25fef2b
## Summary
Added the `claude-plan` preset (no Write, Edit or NotebookEdit tool, no Edit allow rule, Bash allow patterns screened) and `FindFileEditingCommand`, a Go port of cline's command-guard. The guard is a prefilter and defence in depth only; the sandbox stays the boundary.
## Acceptance
- Denylist rejects write commands and output redirection in plan runs, upstream table as corpus -> TestGuardPassesReadOnlyCommands, TestGuardRefusesFileMutations (corpus from command-guard.test.ts), TestPlanPresetKeepsReadOnlyAllowlistAndDropsWrites -> done. In this change the guard runs on the allow patterns of a plan run (the default list and a repo's `Commands.Read`). It does not yet run on each command the agent types; that needs a hook in `cmd/` (see API change requests).
- Docs state it is defence in depth; sandbox remains the boundary -> package comment at the top of `internal/dispatch/local/guard.go` and the doc comments on `FindFileEditingCommand` and `ReadOnly`; no test pins the wording. No file under `docs/` was edited (outside my area).
- Read-only tool allowlist stays auto-approved under the default policy -> TestPlanPresetKeepsReadOnlyAllowlistAndDropsWrites (the only default pattern dropped is `mkdir -p *`, asserted exactly) -> done
- Plan preset removes edit tools -> TestPlanPresetRemovesEditTools, TestClaudePlanPresetIsDefaultAndReadOnly -> done
- Bite-check: each of these reverts turned a test red: dropping `withoutEditTools` (TestPlanPresetRemovesEditTools, TestClaudePlanPresetIsDefaultAndReadOnly), the pattern filter (TestPlanPresetKeepsReadOnlyAllowlistAndDropsWrites), the blocked-command check (TestGuardRefusesFileMutations), the redirect check (TestGuardRefusesFileMutations), and the default `claude-plan` registration (TestClaudePlanPresetIsDefaultAndReadOnly).
- Left out: ticket drafts 1 (gitx) and 3 (plan approval), which belong to other sessions. The argv and structured-input entry points and the plan-mode error message from upstream were dropped because deadcode showed them unreachable from `cmd/factory`.
## API change requests
A per-command check needs a PreToolUse hook that calls `FindFileEditingCommand` (for example a `factory guard` subcommand in `cmd/`), wired into the plan settings. Without it, a plan run is held by the missing edit tools and the sandbox, plus the screened allow patterns.
## Files outside my area
`THIRD_PARTY_NOTICES.md`: new `## cline/cline@50e77bc` section, required by the provenance test.
## Measures
- Non-test Go lines: 21276 before, 21612 after.
- Deadcode lines: 70 before, 70 after (a first draft added 2, deleted).
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand with GOTOOLCHAIN=go1.26.7: gofmt clean, `go vet ./...` clean, golangci-lint v2.13.2 `0 issues.`, `go test -race ./...` and the same with `-tags ee` all ok, `CGO_ENABLED=0 go build ./cmd/factory` ok (BUILD_OK).
## Learnings
- `just` is not installed in cloud sessions; the brief's by-hand recipe worked but the commands are slow (deadcode and lint each exceed the 2 minute foreground limit).
- Go has no regex lookbehind, so the upstream heredoc pattern needed `(?:^|[^<])`.
- The go-landlock and lint dependencies download on first run; warm the module cache in the environment setup.
