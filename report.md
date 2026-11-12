BRANCH: go/k10-dlq
HEAD: e71c03a5c367647e90ca3f46be69c67c4903ad91
## Summary
Added error classes (retryable, terminal, rate-limited), a goroutine-safe dead-letter park that parks a ticket after N unexpected failures, a heartbeat-silence check, and a `Locks.Parked` hook so `Refill` skips parked tickets. The pieces are not wired into reconcile, core, `status` or the dashboard, because that code is outside my area, so they are unreachable from `cmd/factory` today.
## Acceptance
- A ticket failing N times stops being picked -> TestDLQRecord, TestRefillSkipsParked (Symphony 8.1 skip) -> done in `pick`; wiring blocked (see API change requests)
- Classify errors as retryable, terminal, rate-limited -> TestClassify, TestRetryAfter -> done
- Requeue by hand -> TestDLQRequeueAndList -> done in `pick`; no CLI or dashboard command yet (blocked, outside area)
- Appears in `status` and the dashboard DLQ list -> `DLQ.List` / `DLQ.Set` exist -> blocked (`internal/core`, `internal/dashboard`, `cmd/` are outside my area)
- Heartbeat timeout kills a silent session before the hard timeout -> TestSilent (pure predicate) -> blocked for the kill itself (reconcile must call it and Cancel)
- Bite-check: reverted the Refill skip (TestRefillSkipsParked failed), the rate-limited no-count rule (TestDLQRecord failed), the started-time fallback in Silent (TestSilent failed), the count reset on Requeue (TestDLQRequeueAndList failed, after I strengthened it: the first version of the test did not catch this revert).
## API change requests
None to `internal/api`. Wiring requests for others: (1) reconcile `Deps` gets an optional `*pick.DLQ`; `Tick` calls `DLQ.Record` on dispatch failure and stalled Retry, `DLQ.Clear` on MarkDone, and sets `s.Locks.Parked = DLQ.Set()`. (2) `core` owns the DLQ and exposes `List` and `Requeue` for `status`, the dashboard and a CLI command. (3) reconcile calls `pick.Silent` per running entry and issues Cancel plus Retry.
## Files outside my area
None.
## Not done
Temporal files were not copied (ticket says keep structure only), so no `Ported from` header or notices section. Retry/backoff package (ticket 1) and cron.go, checksum.go, priority_queue.go, rescheduler.go belong to other tickets or were out of scope.
## Gate evidence
`just` is not installed; ran the recipe bodies by hand: gofmt clean, go vet clean, golangci-lint (`./internal/pick/...` only) "0 issues.", `go test -race ./...` no failures, `CGO_ENABLED=0 go build ./cmd/factory` built. Full-repo golangci-lint was not run.
Measures: non-test Go lines 21282 -> 21458 (+176, includes nothing deleted). Deadcode: 13 new unreachable entries in `internal/pick` (all new code, until wired); the before and after totals for the whole repo were not measured.
## Learnings
- A DLQ with no owner in core cannot be reachable from `cmd/factory` inside a pick-only area; a brief that demands both needs the core hook in scope.
- `just` missing and the first Go toolchain download cost several minutes; bake both into the image.
