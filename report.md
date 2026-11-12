BRANCH: go/k5-sandbox-lifecycle
HEAD: 99abd934bdbe9acc5808e98bdacb4ad71253c578
## Summary
Added the session lifecycle contract (kill|pause, filesystem pause, autoResume, typed resume error with fresh retry), the time policy (MaxDuration, IdleTimeout, Ephemeral) and two-layer rlimits with a name whitelist, all in pkg/sandbox. Policy.MaxDuration and the whitelisted limits are wired into sandbox.Command; Box and Activity are not reachable from cmd/factory yet.
## Acceptance
- E2B #1: types onTimeout/pauseMode/autoResume -> TestLifecycleValidate -> done
- E2B #1: pause persists workdir, resume cold-starts and reports pauseMode -> TestPauseResumeKeepsWorkdir -> done
- E2B #1: failed resume typed error with retry-without-state -> TestFailedResumeThenFresh -> done
- E2B #1: unit test per transition -> TestIllegalTransitions, TestOnTimeoutAndAutoResume -> done
- microsandbox #1: killed at max duration -> TestPolicyDecide, TestMaxDurationKillsChild -> done
- microsandbox #1: idle reclaimed after timeout; detached children do not block idle; no timeout never reclaimed; table tests -> TestPolicyDecide, TestActivityIgnoresDetached -> done
- microsandbox #2: whitelist, unknown name fails at session start -> TestValidateLimits, TestCommandRejectsUnknownLimit -> done
- microsandbox #2: child inherits baseline, per-exec override -> TestBaselineInheritedAndOverridden, TestMakePlanLayers -> done
- microsandbox #2: RLIMIT_NPROC and RLIMIT_AS enforced -> TestRlimitNproc, TestRlimitASFromLimits -> done (TestRlimitNproc skips as root, as in this container; I ran the compiled test as uid 65534 and it passed)
- Bite-check: each fix reverted once, its test went red (9 reverts: idle foreground check, max-duration check, whitelist, exec layer, timeout wiring, CanRetryFresh, autoResume, onTimeout pause, snapshot copy).
- Left out: the upstream E2B/microsandbox files are not copied. The tickets name only behaviour and Go types, so I wrote them from the contract; no "Ported from" header and no THIRD_PARTY_NOTICES entry were added. Not done: heartbeat idle table from a real exec supervisor (Activity is the timestamp source, nothing calls it yet), Ephemeral has no consumer, E2B tickets #2 and #3 and microsandbox #3 belong to other sessions.
## API change requests
none. To make Box and Activity reachable, a dispatcher in internal/dispatch/local would need to create a Box per session and call Activity.Begin around each exec and Box.Tick on a ticker.
## Files outside my area
pkg/sandbox/plan.go, unix.go, sandbox.go: the smallest hooks (Spec fields Limits, ExecLimits, Policy; ValidateLimits and MaxDuration in Command; extra rlimit names). No other files.
## Gate evidence
`just` is not installed; I ran the recipe bodies by hand with GOTOOLCHAIN=auto: gofmt clean, go vet clean, golangci-lint v2.13.2 "0 issues.", `go test -race ./...` all ok (last lines: `ok  github.com/KaaS-team/factory/pkg/agentrun`, `ok  github.com/KaaS-team/factory/pkg/sandbox`), `CGO_ENABLED=0 go build ./cmd/factory` ok.
Measures: non-test Go lines 20357 -> 20661 (+304; the repo is over its 8000 budget and this adds to it). Deadcode lines 73 -> 81; the new unreachable ones are all Box, ResumeError and Activity methods (14 entries).
## Learnings
- `just` missing in cloud sessions: the brief should say to install it or give a script that runs the recipes.
- go test -race ./... plus lint exceed the 120s foreground limit: run the gate in the background.
- Root in the container hides RLIMIT_NPROC tests; briefs should say to run as another uid (setpriv works).
- "Nothing unreachable from cmd/factory" conflicts with "stay out of cmd/": a library-only ticket cannot meet it without a wiring ticket.
