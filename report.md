BRANCH: go/agentrun-export
HEAD: d6275b6317bcf566d22e68769239b921a7ee0419
## Summary
Added pkg/agentrun: type aliases (Dispatcher, Brief, Budget, Session, Caps, Usage, TicketID, LocalConfig, LocalPreset, LocalRun, Worktrees, GitWorktrees, RoutinesConfig, Meter, Budgets, MeterKey, Spent), ClaudePreset, forwarding NewLocal, NewRoutines, NewMeter. One AGENTS.md test-table line. Nothing in internal/ changed.
## Acceptance
- external test, fake claude on PATH, one Brief to completion, usage via meter -> TestLocalBriefRunsToCompletionAndMeterReadsUsage -> done
- compile-time NewLocal/Dispatcher assertion -> var _ func(...) (agentrun.Dispatcher, error) = agentrun.NewLocal -> done
- go/doc doc-comment walk -> TestEveryExportedIdentifierHasADocComment -> done
## API change requests
None. local.Dispatcher.Wait is not on api.Dispatcher, so NewLocal's interface result cannot Wait; callers poll Usage (or I can export a Waiter alias if wanted). Resume was not found in the local package, so nothing to alias for it.
## Files outside my area
None.
## Gate evidence
gofmt, go vet, go test -race ./... all ok; static build ok; golangci-lint v2.13.2: "0 issues."
## Learnings
- exec resolves argv[0] from the parent PATH, not LocalConfig.Environ. My first test draft set only Environ and ran the real claude (one short real run, about 4s, before I fixed it with t.Setenv). Tests must use t.Setenv("PATH").
- go/parser.ParseDir and ast.Package are flagged by staticcheck; use doc.NewFromFiles.
