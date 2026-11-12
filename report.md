BRANCH: go/mcp
HEAD: 881a7622fc8b93959cdabec5ac2af2096925015b
## Summary
`internal/mcp` serves the twelve factory-mcp tools and two resources over stdio with go-sdk v1.8.0 (pinned). Board, ticket and event views drop usage, cost, budget and event data so no output carries token counts, cost or model names.
## Acceptance
- In-memory client lists exactly the twelve tool names -> TestListsExactlyTwelveTools -> done
- `status` returns the Board; dispatch, steer, cancel, retry reach Control once each -> TestStatusReturnsBoard, TestMutatingToolsReachControlOnce -> done (status returns the Board minus Usage/Budget, see Learnings)
- Nil handler returns a tool error naming the tool -> TestNilHandlerIsToolErrorNamingTool -> done
- `factory://board` and `factory://ticket/7` -> TestResources -> done
- No token count, cost or model name in any tool output -> TestNoToolOutputLeaksUsageCostOrModel -> done
## API change requests
- porttest has no fake Control; I defined one in my test. A shared one would help.
- Control has no per-ticket event read. The ticket resource drains Events for 200ms or until the channel closes; a `TicketEvents(ctx, id)` call would be better.
## Files outside my area
- go.mod, go.sum: the go-sdk dependency (named by the ticket) and its tidy results.
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt clean, go vet clean, `go test -race ./...` all ok, golangci-lint v2.13.2: "0 issues.", `CGO_ENABLED=0 go build ./cmd/factory` built.
## Learnings
- Board JSON carries Usage and Budget, which conflicts with the no-tokens acceptance line; I used a redacted view.
- `NewCommand()` takes no Control, so it needs `WithControl(...)` wired from cmd/ (not done, outside my area).
- Red phase was a compile failure, not a behavioral failure, since the package did not exist.
- golangci-lint via `go run` takes over 2 minutes cold; install it in the image.
