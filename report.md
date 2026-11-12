BRANCH: go/k5-serve-jobs
HEAD: fddb4c848d03d3d851ffe1acd66498490d46a631
## Summary
`internal/serve` now has a SQLite job scheduler (`jobs.go`): pause, unpause, run_now, kill, cron update, per-job run history, bad jobs skipped at load with a logged reason, one-statement claim, attempt^4 backoff with jitter, snooze, stuck-run requeue, a TTL leader lease and period-keyed tick inserts. The controls are served over HTTP from `Serve`. No upstream code was copied, so there is no notice entry. I used behaviour only (cron 5/6 fields, skip bad jobs at load, river claim semantics) and did not clone goose or river.
## Acceptance
- goose #3 pause, unpause -> TestJobs_PauseUnpause -> done
- goose #3 run_now -> TestJobs_RunNowQueuesImmediatelyEvenWhenPaused -> done
- goose #3 kill -> TestJobs_KillCancelsRunningRun -> done
- goose #3 update cron -> TestJobs_UpdateCron, TestJobs_CronFieldCounts -> done
- goose #3 per-job run history -> TestJobs_HistoryRecordsOutcomes -> done
- goose #3 each control reachable over HTTP, jobs created over HTTP -> TestServe_JobControlsOverHTTP, TestServe_RunsJobs -> done
- goose #3 corrupt job does not stop the daemon, logged reason -> TestJobs_CorruptJobSkippedAtLoad -> done
- goose #3 tool-repeat guard in run -> blocked (not attempted): the ticket header says it belongs to the loop-guard session, and `run` is outside `internal/serve`
- river #2 claim in one statement -> TestJobs_ClaimIsExclusive (SQLite UPDATE ... RETURNING with a subselect, not SKIP LOCKED) -> done
- river #2 backoff attempt^4, 10% jitter, cap -> TestBackoff, TestJobs_FailureRetriesWithBackoffThenFails -> done
- river #2 snooze is not an attempt -> TestJobs_SnoozeDoesNotCountAsAttempt -> done
- river #2 stuck running row requeued after timeout -> TestJobs_StuckRunningRowRequeuedAfterTimeout, TestJobs_StuckRunOutOfAttemptsFails -> done
- river #3 TTL leader with jitter, one daemon ticks, failover -> TestJobs_OnlyLeaderFiresTicksAndFailsOver, TestLeaseJitterStaysInBand -> done
- river #3 period-keyed unique insert -> TestJobs_PeriodKeyedInsertPreventsDoubleTick -> done
- river #1 mailbox dedupe (100 concurrent duplicate inserts) -> blocked: the kaasbot mailbox is not in this repo and not in my area. The (job, period) unique key covers the serve tick path only.

Bite-check, each reverted once and its test went red: unique-key removal, lease `WHERE` clause, snooze attempt decrement, requeue out-of-attempts branch, backoff exponent, skip-bad-job, kill cancel (test hangs, killed by timeout), paused check, unpause cursor, kill status guard. One first mutation (ON CONFLICT DO UPDATE) survived because the key alone still dedupes; the schema-level mutation covers it. Spec cites: Symphony 8.1 (tick) and 8.4 (retry) in test names and comments. Note 8.4 gives 2^n backoff, but the ticket asks for river's attempt^4, so I followed the ticket.
Known limits: kill cancels only a run executing in the same daemon; another daemon's run is marked killed in the DB but its executor is not interrupted. Run history rows are never pruned.
Measures: non-test Go lines 20357 -> 20959 (+602, the repo is far over the 8000 budget, and this adds a feature). Deadcode 68 -> 68 (baseline from a clean worktree of origin/next).
## API change requests
None to `internal/api`.
## Files outside my area
- go.mod, go.sum: added `github.com/robfig/cron/v3 v3.0.1` (MIT), the dependency the ticket names.
Request for `cmd/factory/serve.go` (not edited): pass `serve.Options{JobsPath: <db path>, Exec: <executor>}`. Until then no job executes in the real daemon, though the code is reachable from `Serve`.
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: gofmt -l (empty), go vet ./... (clean), golangci-lint v2.13.2 on go1.26.7 (`0 issues.`), `go test -race ./...` (all ok), `CGO_ENABLED=0 go build ./cmd/factory` (ok). Exit 0.
## Learnings
- `just` is absent in cloud sessions; the brief's fallback list worked.
- The "reachable from cmd/factory" rule conflicts with "never edit cmd/": serve controls had to hang off Server.Handler and Options.JobsPath to count as reachable. The factory should either allow a one-line cmd wiring edit or state this.
- A first test that used a fake clock with a fixed time collided on the run_now unique key; derive uniqueness from the row id, not the clock.
- Background mutation runs that hang on a missing cancel need `-timeout 30s`.
