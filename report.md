BRANCH: go/k5-loop-guard
HEAD: f46a13ba111d6ec4b070be4917e53539a63a08a2
## Summary
New `internal/dispatch/local/stuck` ports OpenHands `stuck_detector.py` to Go over `claude -p` stream-json events, and the local dispatcher feeds every stdout line to it: one nudge on the first hit, then the run is killed and `Wait` returns `ErrStuck` naming the pattern. The nudge goes through `Steer`, which still returns `ErrUnsupported`, so it is counted but not delivered to the agent.
## Acceptance
- Go package parses stream-json tool events -> `TestPatterns` (rows for tool_use, tool_result, is_error, text, user message, compact_boundary, junk lines) -> done
- Detects the 5 patterns, thresholds 4/3/3/6, 20-event window -> `TestPatterns` scenario 1-5 rows (below and at each threshold), `TestWindowIsTwentyEvents`, `TestWindowIsTwentyEventsForAlternation` -> done (scenario 5 caveat below)
- One nudge, then abort on the next hit -> `TestNudgeIsOnePerRun`, `TestPatterns/scenario 1: the next 4 repeats after the nudge abort`, `TestPatterns/scenario 2 ... nudge at 3, abort at 4`, `local.TestStuckRunIsNudgedThenAborted` (real child process killed, `errors.Is(err, ErrStuck)`) -> done
- Fixture tests for each pattern -> `TestPatterns`; fixtures are generated JSON lines in the test file, not files under testdata -> done
- MIT notice in file header -> `stuck.go` header plus `## OpenHands/software-agent-sdk@10be259` in `THIRD_PARTY_NOTICES.md`; `internal/provenance` passes -> done
- Bite-check: reverted by mutation, each made a test red: each threshold (4, 3, 3, 6), window 20, abort above action-error threshold, nudge-then-abort state, window reset after a nudge, user-message reset, parallel calls as one attempt, result kind compared, monologue count, and in `local.go` the cancel, the `ErrStuck` result and (via the same test) the hook. Two first attempts survived (window size, abort threshold); I strengthened the tests and they then failed.
## API change requests
- `Steer` is unsupported for `claude -p` (pinned argv has no input channel), so the nudge cannot reach the agent. If a future preset runs with `--input-format stream-json`, `Steer` can deliver it; the hook already calls `Steer`.
## Files outside my area
- `THIRD_PARTY_NOTICES.md` (the section the provenance test requires).
Deviations from upstream: scenario 5 (context-window loop) is a stub upstream; here it is three consecutive `compact_boundary` events with at least 10 in the window. An action's thought is not compared, because stream-json delivers it as a separate line. The invalid-call and pydantic validation branches are dropped. Nothing else was left out.
## Gate evidence
`just` is not installed here, so I ran the recipe bodies by hand: gofmt, `go vet ./...`, golangci-lint v2.13.2 (0 issues on the dispatch packages and clean in the full run), `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. The chain ended with:
ok  	github.com/KaaS-team/factory/pkg/sandbox	1.343s
GATE-OK
Measures: non-test Go lines (excluding `src/`) 20357 before, 20753 after (+377 stuck.go, +19 local.go). Deadcode lines 68 before, 68 after (nothing from `stuck`).
## Learnings
- `just` missing in the cloud image: install it in the environment instead of running recipe bodies by hand.
- Cold `go run` of golangci-lint plus `go test -race ./...` exceeds the 120 s tool timeout; run the gate in the background from the start.
- Measuring deadcode "before" needs a clean worktree of `origin/next`; a stash leaves untracked new packages in the build.
