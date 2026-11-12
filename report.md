BRANCH: go/k8-mergeq-outcomes
HEAD: 535f24cd14c9807ad88f8b71950fe87ed9f9cff5
## Summary
Added `Halve`, `Take` (split.go) and `PushOutcome`, `Backoff`, batch timeout (outcome.go), hooked into Plan and Runner. Ticket #3 left out as instructed. Measures: non-test Go lines 21276 before, 21388 after (+112 including the new Runner hooks); deadcode 70 before, 70 after.
## Acceptance
- failed batch of N>1 yields floor(N/2) and rest; N=1 failed -> TestHalve (N=1,2,3,8) -> done (bite: ceil split fails it)
- is_single PRs never share a batch -> TestTakeIsolatesSinglePRs, TestPlanIsolatesSinglePRs -> done in mergeq; blocked in production: nothing sets `Entry.Single` yet (see API change requests)
- non-ff push retries whole batch without bisect -> TestPushOutcome, TestRunNonFFRetriesWholeBatch -> done (bite: classifier disabled fails both)
- unknown push error does not retry -> TestRunUnknownPushErrorDoesNotRetry -> done
- per-batch timeout splits like a CI failure -> TestRunBatchTimeoutSplitsLikeCIFailure, TestRunCancelIsNotATimeout -> done (bite: fails without the timeout branch); production default is no timeout until cmd sets `Config.BatchTimeout`
- push backoff capped -> TestBackoffIsCapped, TestRunNonFFRetriesWholeBatch -> done (bite: uncapped fails)
Already there: bisect by halving to a lone culprit (Plan/resolve, ceil-half), eject of a lone culprit, ErrBaseMoved re-plans the batch, unknown push errors stop the run. I changed the split to floor(N/2) first and made the existing behaviours explicit. No code text from bors-ng was carried over (logic port only, divider.ex@ca72579, batcher.ex complete_batch), so no header or THIRD_PARTY_NOTICES section was added. bors-ng `sort_batches` and `batch_state` were not ported: the Plan model has no batch rows or priorities to order or state-tag.
## API change requests
- `api` / `corequeue.go` Entry source: the core queue has no way to mark a PR single (coreStore.Queued builds Entry without Single). Needs a ticket label or flag read in the tracker layer.
- cmd/factory should set `mergeq.Config.BatchTimeout`, `PushBackoff`, `PushBackoffMax` (defaults are zero: no timeout, no wait).
## Files outside my area
none
## Gate evidence
`just` missing; ran its recipes by hand: gofmt -l (empty), go vet, golangci-lint v2.13.2 `0 issues.`, `go test -race ./...` all ok (last: `ok  github.com/KaaS-team/factory/pkg/sandbox 1.308s`), `CGO_ENABLED=0 go build ./cmd/factory` BUILD_OK.
## Learnings
- `just` is not installed in cloud sessions; the factory default image should include it.
- `go test -race ./...` plus lint exceeds the 120s tool timeout; run it in the background.
- A Monitor call needs ToolSearch first; polling the output file works as well.
