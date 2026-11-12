BRANCH: go/k4-dashboard
HEAD: 0716c8731de0b0e4d1d8bcf9f32bc7747e0a1a78
## Summary
No code change. `internal/dashboard` already on `next` (from K3) meets all three acceptance lines, so I added nothing, in line with the 8000-line budget. The branch points at the current `origin/next` head.
## Acceptance
- httptest: board lists tickets from a fake control; ticket page shows the timeline -> TestBoardRendersEverySlot, TestQueueAndTimelinePages, TestTicketPageRendersHistoryGolden -> done (already present)
- Without operator role the HTML has no token, cost or model string -> TestOperatorGate (greps body of /, /queue, /ticket/101 for usage, budget, cost, model, claude and the numbers) -> done (already present)
- Only internal/api imported among internal packages -> go list shows internal/api (and internal/api/porttest in tests only) -> done (no test pins this; I checked by hand)
## API change requests
none
## Files outside my area
none
## Measures
- Non-test Go lines before and after: 20357 / 20357
- Deadcode before and after: 72 / 72
## Gate evidence
just is missing, so I ran the recipe bodies by hand: gofmt -l (empty), go vet, golangci-lint v2.13.2 ("0 issues."), go test -race ./... (all ok, last: ok  github.com/KaaS-team/factory/pkg/sandbox), CGO_ENABLED=0 go build ./cmd/factory. Final line: GATE-OK
## Learnings
- The ticket was already done by K3; briefs should be checked against `next` before dispatch.
- I did not see the new tests fail first, because there are none. Existing tests were run, not mutation-checked.
- No test enforces the "only internal/api" import rule; a small go list test would pin it.
