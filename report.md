BRANCH: go/k4-test-quality
HEAD: 0504b4f14e1de235faabd0716c9d18163741bd27
## Summary
Most of the K3 findings were already fixed on `next` (conformance already runs `reconcile` behaviour tests, `serve` and `a2a` tests cover the mounted commands, the one golden is read). I closed the remaining gaps: a missing claim-state test, the sleep in `pkg/agentrun`, and an unreachable `a2a` failed phase with a wrong comment.
## Acceptance
- Each conformance test fails when the behaviour it names is broken -> 17.4: Test17_4_BackoffFormula, AbnormalExitBackoff, ConfiguredBackoffCap (backoff doubling changed to tripling), Test17_4_RetryEntryFields (stall retry reason dropped); 17.6: Test17_6_ErrorsReachOperator (OnError never called); 18.1: BackoffFormula and ConfiguredBackoffCap (cap ignored) -> done. Each mutation was applied to reconcile, seen red, and reverted. One survived (claimed no longer holds a slot), so I added Test17_4_ClaimStatesHoldSlots, mapped under 18.1, and saw it go red on that mutation.
- No `time.Sleep` in tests under my area -> TestLocalBriefRunsToCompletionAndMeterReadsUsage now waits on the dispatcher's `Wait` -> done (grep finds none; passes with -count=5)
- Every golden file under my area is read by a test -> `internal/a2a/testdata/agent-card.json` is read by TestAgentCardGolden; it is the only golden there -> done
- `internal/a2a` false claim -> removed the `PhaseFailed` phase (no mounted code produced it) and corrected the `server` comment (push-config methods return a different error than unsupported); TestUnmappedPhaseAndUnservedMethodsFail added -> done
- `internal/serve` tests assert on an unmounted command -> not found: `factory serve` and `factory a2a` are both mounted in cmd/factory/main.go, and the serve tests drive `Server`, which `newServe` uses -> nothing to change
## API change requests
none
## Files outside my area
none
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand (GOTOOLCHAIN=go1.26.7): gofmt clean, go vet clean, golangci-lint "0 issues.", go test -race ./... no failures, CGO_ENABLED=0 go build ./cmd/factory BUILD_OK.
Measures: non-test Go lines 20357 before, 20353 after. Deadcode 68 before, 68 after.
## Learnings
- The brief described the K3 audit, but half its findings were already fixed on `next`; the brief should be regenerated from the current tree.
- `go test -race ./...` plus lint exceeds the 120s tool timeout; run the gate in the background.
- `just` is missing in cloud sessions; the image should install it.
