BRANCH: go/k10-eventlog
HEAD: ccbd0f4c0034b3e96d56f904bef2034ebc316d55
## Summary
Added `internal/reconcile/eventlog`, an append-only per-ticket step log whose every line carries a checksum of the ticket state after that step, and hooked it into `reconcile.Tick` and `core.recover` so a restart replays it and does not repeat a logged dispatch. Nothing like it existed on `next`; no upstream code was copied (the idea is Temporal's checksum.go and mutable_state_rebuilder.go), so no THIRD_PARTY_NOTICES entry.
## Acceptance
- kill -9 mid-ticket and restart: no completed step is re-run, spend after restart for completed steps is 0 -> reconcile TestRestartReplaysLogNoRepeatedDispatch (dispatch count stays 2 across a fresh process on the same log; a dispatch is the fire that spends tokens, no real token is used), TestRestartKeepsRetryQueue, TestRestartDropsEndedAndUnlisted, TestStepsAreLogged, core TestRestartReplaysStepLog -> done
- checksum mismatch triggers rebuild from the log and an audit event -> eventlog TestReplayChecksumMismatch, TestReplayTornTail, TestReplayRepairs; reconcile TestRestartChecksumMismatchAudits -> done. Interpretation: the log is rebuilt as the valid prefix before the first bad line (bad tail kept in `<ticket>.jsonl.bad`), an `audit` step is appended, and the message goes to `Deps.OnError`. The audit is not a separate dashboard event.
- Bite-check: reverted each of these once and the named tests went red: logging of dispatch, steer, retry, end on mark-done, end on needs-human, end on cancel; the log-wins merge in Restore; the audit report; checksum compare; truncate; sequence check; torn-line check. Two first-round survivors (end on mark-done, retry) were fixed by asserting on the log directly. The requeue step survived, so I deleted that step (it only carried a marker string).
## Already there
`reconcile.recoverState` and `core.recover` rebuilt state from tracker plus observer only (Symphony 14.3); both are kept and the log is overlaid on them. No event log, checksum or replay existed.
## API change requests
- `cmd/factory/control.go` (not mine to edit): in `buildDeps` set `core.Deps.Log` from `eventlog.Open(<state dir>/events)`. Until then `eventlog.Open` is the one new function deadcode reports unreachable; Append and Replay are reachable through core.
- `internal/core/control.go` manual `Dispatch` writes `Entries` directly and does not log the step; it should call the same log hook.
## Files outside my area
- `internal/core/core.go` (+9 lines): `Deps.Log`, passed to `reconcileDeps`, and `recover` calls `Restore` because production restart goes through `core.recover`, not `reconcile.recoverState`.
- `internal/core/core_test.go`: one test, TestRestartReplaysStepLog.
## Measures
- Non-test Go lines (excluding src/): before 21276, after 21582 (+306, this includes the uncommitted-tree count of files in the change; the log is the cost). Not deleted: nothing became redundant.
- deadcode: before 70, after 71 (`eventlog.Open`, see API change requests).
- `just` is missing here: ran the recipe bodies by hand (gofmt, vet, golangci-lint v2.13.2 on go1.26.7: 0 issues, `go test -race ./...`, same with `-tags ee`, `CGO_ENABLED=0 go build ./cmd/factory`), all passing.
## Gate evidence
golangci-lint: `0 issues.`; test and vet runs printed no failure lines; `BUILD OK` for the static build. Race and ee runs ended with exit code 0.
## Learnings
- `just` is not installed in cloud sessions; the factory default should ship it or the recipe bodies as a script.
- The production restart path (`core.recover`) duplicates `reconcile.recoverState`; a hook in only one is unreachable. One owner for restart would remove the duplicate.
- A restart test that goes through Tick can hide a missing log step because Decide re-derives it; assert on the log itself.
- First deadcode run takes 30s and the lint download over 2 minutes; run them in the background early.
