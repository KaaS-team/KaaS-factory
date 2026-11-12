BRANCH: go/k10-fair
HEAD: c88a779f3b30d95ac26c2e4de752a2fb0e2d3c08
## Summary
Ported the DRR algorithm from trigger.dev drr.ts (in process, no Redis or Lua) into internal/pick/fair.go, hooked into Refill through Locks.Fair, with a per-repo cap. It is not yet reachable from cmd/factory.
## Acceptance
- One repo with 100 tickets cannot hold more than its cap -> TestFairCapHoldsOneRepoToItsCap, TestFairCapCountsRunning -> done
- Other repos get a slot within one round -> TestFairOtherRepoGetsSlotWithinOneRound, TestFairDeficitFavoursRepoServedLess -> done
- NOTICE file lists the Apache-2.0 sources -> internal/provenance TestRepoNoticesMatchHeaders -> done
- Reachable from cmd/factory -> blocked (wiring lives in internal/reconcile and cmd/, outside my area)
- Bite-check: removing the cap check failed the two cap tests; removing the ordering hook failed the one-round test; removing the deficit charge failed the deficit test.
- Not done: the other copy-list rows (retries, schedule, visibility) belong to tickets 1 and 2.
## API change requests
Create one pick.NewFair(quantum, maxDeficit, cap) per run and set Locks.Fair (reconcile.Config.InitialLocks or Tick state), with the cap from config. deadcode flags NewFair as unreachable until this lands.
## Files outside my area
THIRD_PARTY_NOTICES.md, one new section (required by the provenance test).
## Gate evidence
just is not installed; ran recipe bodies by hand: gofmt clean, go vet clean, golangci-lint 0 issues (internal/pick only), go test -race ./... no failures, CGO_ENABLED=0 go build ./cmd/factory built.
Non-test Go lines: 21276 before, 21294 after. Deadcode lines: 75 before, 71 after (the drop is unexplained; the only new line from my change is NewFair).
## Learnings
- Fresh toolchain and module downloads made the first full race run exceed the 120s foreground timeout; run it in the background from the start.
- A pure, stateless pick package needs the caller to own DRR state; the brief should say who creates it.
