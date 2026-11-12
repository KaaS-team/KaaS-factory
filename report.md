BRANCH: go/dashboard
HEAD: 919eccc6c5207a7ac0833e19e0bc355e8451f058
## Summary
Added `internal/dashboard`: `Handler(ctl, Options)` serving board, queue, ticket timeline and an SSE `/events` endpoint (GET only, html/template embedded), plus `NewCommand()` (`factory dashboard --addr`, default 127.0.0.1:8787, `--operator`). One commit; all files in `internal/dashboard/`.
## Acceptance
- GET / renders every slot of a fake Board -> TestBoardRendersEverySlot -> done
- Operator false hides usage, budget, cost, model; true shows usage -> TestOperatorGate, TestEventsHideUsageWithoutOperator -> done
- No route accepts POST, PUT, PATCH or DELETE -> TestNoWriteRoutes (walks routes()) -> done
- /events streams api.Event JSON as SSE; client close releases subscription (-race) -> TestEventsStreamsAndReleases -> done
- Default address is 127.0.0.1 -> TestDefaultAddrIsLoopback -> done
## API change requests
- Control has no history read, so the ticket timeline is live only: the page shows current slot state and appends SSE events for that ticket as they arrive. A `History(ctx, id) ([]Event, error)` on Control would let it render past events server-side.
- `NewCommand()` takes no Control; it reads one from the command context via `dashboard.WithControl`. The owner of cmd/ must wire that when registering the command (not done here, outside my area).
## Files outside my area
none
## Gate evidence
`just` is missing; ran recipe bodies by hand: gofmt -l clean, go vet ./... clean, golangci-lint v2.13.2 "0 issues.", `go test -race ./...` all ok (internal/dashboard ok, internal/provenance ok), CGO_ENABLED=0 go build ok (BUILD_OK).
## Learnings
- Red phase was a compile failure (no code yet); module path is github.com/KaaS-team/factory, not the repo name. The brief should say so.
- Cold lint run via `go run` exceeds the 120s tool timeout; run it in the background.
- Spec section citations (symphony-spec.md) not used; the ticket touches no scheduler section.
