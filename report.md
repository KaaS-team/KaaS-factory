BRANCH: go/k10-catchup
HEAD: 0957fd2c437af087a78628f282be78bc3d943664
## Summary
`factory serve` now has a cron scheduler (`internal/serve/schedule.go`) that fires only the latest missed tick after downtime, with deterministic 0..30 s jitter, ported from trigger.dev@2fbd5c7. Nothing like it existed on `next`; it is ticked by `Serve` and wired from the default workflow's `on: schedule` trigger.
## Acceptance
- Restart after 6h with an hourly schedule fires once -> TestCatchUpFiresLatestMissedOnly (and TestTickTwiceFiresOnce, TestServeTicksSchedules) -> done
- Same minute across 50 teammates spreads starts over the window -> TestJitterSpreadsTeammates (50 ids land in at least 15 of 30 seconds, deterministic, within window) -> done
- Unit tests for DST and timezone -> TestZoneAndDST (winter, spring change, summer, fall back, spring-forward gap day), TestValidate (bad zone) -> done
- Also tested: first sight starts from now, a failed Fire stays due, jitter makes a tick due early, file store round trip.
- Bite-checks (each fix reverted once, its test went red): Skipped flag (CatchUp, ServeTicks), latest-only (CatchUp, TwiceFiresOnce, ServeTicks), zero jitter (Spreads), final mix (Spreads), Store.Set after fire (TwiceFiresOnce), CRON_TZ prefix (ZoneAndDST).
- Found already there: nothing for catch-up or jitter. `graph.Trigger` already parsed `on: schedule` (not validated as cron). `vendorkit` has its own retry jitter, unrelated.
- Left out: tickets 2 and 3 (other sessions); retries.ts, scheduleTiming.ts (phase/window/min-duration guard), drr.ts, visibility.ts (not in this ticket's acceptance).
- Deviations from the port: FNV-1a alone put 50 ids that differ in one character into 10 of 30 seconds, so a murmur3 finalizer is applied. Catch-up walks `Next` forward (robfig/cron has no `Prev`), capped at 100000 ticks per pass. Jitter fires before the tick, as upstream does.
## API change requests
`api.Control` has no call that starts a workflow by name, so a due schedule only prints a line to stderr and records the tick in `.factory/state/schedules.json`. Request: `Control.RunWorkflow(ctx, name)` (or an equivalent), then `cmd/factory/serve.go`'s `Fire` should call it.
## Files outside my area
- `cmd/factory/serve.go`: smallest edit to make the code reachable from `cmd/factory` (load default workflow, build Scheduler).
- `go.mod`, `go.sum`: `github.com/robfig/cron/v3 v3.0.1` (MIT), as the ticket names it.
- `NOTICE`, `THIRD_PARTY_NOTICES.md`: Apache-2.0 notice entries the ticket requires. robfig/cron (MIT) is a dependency, not ported code, so it has no notices entry.
## Gate evidence
`just` is not installed; ran the recipe bodies by hand: gofmt clean, `go vet ./...`, golangci-lint v2.13.2 (GOTOOLCHAIN=go1.26.7) "0 issues.", `go test -race ./...` and `-tags ee` all ok, `CGO_ENABLED=0 go build ./cmd/factory` BUILD_OK. Last lines:
ok  	github.com/KaaS-team/factory/pkg/agentrun	1.023s
ok  	github.com/KaaS-team/factory/pkg/sandbox	1.278s
BUILD_OK
Measures: non-test Go lines 21276 -> 21322 (+46); deadcode 70 -> 70 (none mine).
## Learnings
- `just` is missing in cloud sessions; the brief should say to run the recipe bodies directly.
- golangci-lint via `go run` downloads for minutes and trips the 120 s foreground limit; run it in the background.
- A cloud commit gets a `Signed-off-by: Claude` line from `-s`; the harness attribution asks for a session trailer that the brief forbids, so the brief wins.
