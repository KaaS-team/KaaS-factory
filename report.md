BRANCH: go/k10-retry
HEAD: 8ac1c8896cdb4d4e51b3c324b51fd4f7389e54df
## Summary
New `pkg/retry` forked from temporalio/temporal@bfabec7 common/backoff (exponential policy with attempt cap, expiry, jitter and overflow guard, a `Retrier`, and a context-aware `Loop` with retryable predicate and a minimum-delay hook). `internal/tracker/vendorkit.Client.Do` now runs on it and its own backoff loop and `Jitter` field are deleted.
## Acceptance
- Shared retry package, MIT header kept, SHA pinned in THIRD_PARTY_NOTICES.md, no go.temporal.io dependency -> provenance test, `pkg/retry/retry_test.go` -> done
- Table tests for max attempts -> TestExponentialComputeNextDelay (max attempts rows), TestLoop, TestDoRetryRules -> done
- Expiry -> TestExponentialComputeNextDelay (expiry rows), TestLoopExpiry -> done
- Jitter bounds -> TestExponentialComputeNextDelay (200 draws per row, [0.8x, x)), TestDoBackoffGrowsWithJitter -> done
- Overflow -> TestExponentialComputeNextDelay "overflow stops instead of wrapping" -> done, but see bite-check note
- Tracker retry loop uses it (Symphony 8.4) -> internal/tracker/vendorkit tests (TestDoRetryRules, TestDoRetryAfterHeader, TestDoStopsWhenContextEnds) -> done
- Fire retry loop uses it -> blocked: `internal/dispatch/fire` has no retry loop. It returns `*RateError` with `RetryAt` and makes one HTTP call. Nothing to switch.
- Kaasbot wake retry loops -> blocked: kaasbot is not in this repo (ticket says adoption comes later).
- Left out of the fork (deadcode rule: nothing added may be unreachable from cmd/factory): ErrorDependentRetryPolicy, ConstantDelayRetryPolicy, Conditional policy, Disabled policy, Retrier.Reset, jitter.go (Jitter, FullJitter), the generic ThrottleRetryContextWithReturn, cron.go. They are at the pinned SHA when kaasbot needs them. The ticket said to keep the first three and jitter.go, so this departs from the ticket on purpose.
- Throttle: temporal's ResourceExhausted special case is replaced by `Loop.MinDelay`, which vendorkit uses for Retry-After.
- Behaviour change in vendorkit: waits are now jittered down into [0.8x, x) (temporal's formula) instead of x plus up to 50%.
## Bite-check
Each mutation made one test go red, then was reverted: max attempts `>=` to `>`, expiry clamp removed, jitter factor 0.8 to 1.5, non-positive guard removed, MinDelay ignored, deadline check disabled, retryable predicate removed, vendorkit attempt cap raised (TestDoRetryRules). Not biteable on amd64: the overflow guard (the wrapped conversion also trips the "below initial interval" check, as the upstream comment says; it only matters on arm64) and the `elapsed > expiry` check (equivalent, the remaining-time clamp already returns Done). Tests were written after the code, not before; the bite-check is the proof.
## Measures
- Non-test Go lines (outside src/): before 21276, after 21452.
- Deadcode: before 70, after 70 (`GOTOOLCHAIN=go1.26.7`, deadcode@v0.39.0). pkg/retry adds no unreachable function.
## API change requests
none
## Files outside my area
- `internal/tracker/vendorkit/client.go` and its test: the ticket names the tracker retry loop as in area.
- `THIRD_PARTY_NOTICES.md`: required by the provenance test.
## Gate evidence
`just` is not installed; I ran the recipe bodies chained with &&: gofmt -l, go vet ./..., golangci-lint v2.13.2 (GOTOOLCHAIN=go1.26.7), go test -race ./..., go vet and go test -race with -tags ee, CGO_ENABLED=0 go build. All passed, no FAIL lines:
ok  	github.com/KaaS-team/factory/pkg/agentrun	1.016s
ok  	github.com/KaaS-team/factory/pkg/retry	1.025s
ok  	github.com/KaaS-team/factory/pkg/sandbox	1.280s
## Learnings
- The full gate takes more than 2 minutes cold (module downloads); run it in the background from the start.
- errorlint rejects `err == ctx.Err()` and `err != sentinel`, including in a verbatim port; run lint before the first push.
- A ticket that says "all fire/tracker/wake loops use it" should name the loops; fire has none and kaasbot is out of tree.
