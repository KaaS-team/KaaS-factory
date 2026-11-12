BRANCH: go/k2f-a2a
HEAD: b3fbb48f9077902f3e9cb266225b0a9603c13625
## Summary
`internal/a2a` serves the factory as an A2A agent: public agent card, bearer-protected `message/send` and `tasks/get`, and a `factory a2a --addr` command. SDK is `github.com/a2aproject/a2a-go/v2` v2.8.0 (newest stable of the v2 line; LICENSE checked, Apache-2.0). It speaks A2A v0.3 JSON-RPC through the SDK's `a2acompat/a2av0` package, because the ticket's method names (`message/send`, `tasks/get`) are v0.3 names.
## Acceptance
- Agent card golden -> TestAgentCardGolden (testdata/agent-card.json) -> done
- Phase-to-state table covering every api.Phase -> TestStateForPhase -> done (see "API change requests": api has no failed phase, so the table has a local `PhaseFailed` row; queued/merge-queue/done/stalled/retry map to working)
- send then get round trip on porttest fakes -> TestSendThenGetRoundTrip -> done
- unauthenticated request gets 401 -> TestAuth -> done (card stays public; JSON-RPC needs the token; an empty server token also gives 401)
- empty token refuses to start -> TestCommandRefusesEmptyToken -> done
Test-that-bites: with the bearer check disabled TestAuth fails.
## API change requests
- `api.Tracker` has no create. I define `a2a.Filer` (`Create(ctx, api.Ticket) (api.TicketID, error)`), which the GitHub tracker's existing `Create` already satisfies.
- `api.Tracker` cannot read a ticket's phase. I define `a2a.PhaseReader` (`Phase(ctx, id) (api.Phase, error)`). The supervisor needs an implementation, from labels or the board.
- `api.Phase` has no failed value although factory:failed exists as a label. Please add one, or confirm failed maps to needs-human.
- Tests use a small local fake adding Create and Phase on top of `porttest.Tracker`. `porttest` could grow both.
## Files outside my area
- `go.mod`, `go.sum`: the a2a-go dependency. `go mod tidy` also raised golang.org/x/oauth2 (0.35.0 to 0.36.0), go-jose/v4 (4.0.5 to 4.1.4) and x/crypto (0.55.0 to 0.57.0), and added grpc and protobuf as indirect dependencies of the SDK.
## Gate evidence
`just` is not installed, so I ran the recipes by hand: gofmt -l, go vet ./..., golangci-lint v2.13.2 on go1.26.7, go test -race ./..., CGO_ENABLED=0 go build.
```
0 issues.
ok  	github.com/KaaS-team/factory/pkg/agentrun	1.039s
GATE-OK
```
## Learnings
- `NewCommand()` as specified cannot build a tracker, so it takes a `DepsFunc`; cmd wiring (outside my area) must pass one.
- All work went into one commit and push, not one per acceptance line, because the package is small and the lines share files.
- The brief's "queued/planned/verifying" and "failed" do not match api.Phase names; the brief should list real phase names.
- a2a-go v2 serves A2A v0.3 only through the compat package; a v1 client will not reach `message/send`.
