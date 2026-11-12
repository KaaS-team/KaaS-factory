BRANCH: go/k7-autosubmit
HEAD: ff5d0da9ee57e70f63df5edede1512b46df25733
## Summary
A local run that passes its call or cost cap is stopped, and any run that dies on its own is submitted: the worktree diff is committed, pushed and a draft PR marked partial is opened through a narrow `PRs` port. Not wired into `cmd/factory` (outside my area), so the new code is not yet reachable from the CLI.
## Acceptance
- Forced budget breach yields a partial PR -> TestCallCapBreachOpensAPartialPRWithinTheMargin, TestSubmitPushesTheDiffAndOpensAPartialPR -> done
- No cap overrun beyond a stated margin (CallMargin = 1 call) -> same test asserts calls <= cap + CallMargin; TestGuardFeedRows covers every guard branch -> done. Cost is enforced only on cost the stream reports (the result line), so the cost margin is whatever a stream line carries; the argv `--max-budget-usd` remains the hard cost stop.
- Caps and spend stay out of PR bodies -> TestPRBodyHasNoCapsOrSpend -> done
- Crash submitted, clean exit and operator Cancel not -> TestAbnormalExitRows -> done
Bite-checks (revert, test red): no kill on breach, cancel submits, crash not submitted, call cap off by one, hook blocks commit all failed their tests. The "no ErrNothing check" revert did not compile in my sed, so it was not bite-checked.
## API change requests
none. cmd/factory/control.go needs `Autosubmit: &autosubmit.Submitter{Caps: ..., PRs: <github adapter>}` in local.Config, and a PRs adapter does not exist yet.
## Files outside my area
none
## Gate evidence
`just` is missing; ran by hand. gofmt clean, `go vet ./...` clean, `go test -count=1 ./internal/dispatch/... ./pkg/...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` ok. Full `go test -race ./...` and golangci-lint did not finish in this session, so `just check` is NOT confirmed green. Deadcode run was denied by the sandbox classifier, not measured.
Non-test Go lines: before 20980, after 21164.
## Learnings
- Module downloads make the full gate exceed the 120s foreground limit; warm the module cache first.
- Deadcode via `go run ...@version` was blocked here; vendor or preinstall it.
