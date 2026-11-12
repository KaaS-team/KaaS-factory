BRANCH: go/report-source
HEAD: c7d3bad895324aab421ccd2b9068e486f564dbd0
## Summary
`report.StoreSource{Store, Ledger}` now implements `report.Source` from new store tables (team and pack, merge and dispatch times, chatops and manual-push counts) and from per-attempt token rows added to the spend ledger comment. Rebuild restores the new tables from ticket labels and an optional tracker thread read.
## Acceptance
- Three-ticket store (one merged, one failed twice then merged, one never merged) gives the same numbers through StoreSource -> TestStoreSourceMatchesHandComputedReport -> done. It uses a new golden checked by hand (see the test comment), because the existing five-ticket fixture cannot be built from three tickets. The scenario is a merged ticket, a ticket with a failed first attempt that merged, and an unmerged ticket plus an unspent one. Totals: 2 merged PRs, 2900 merged tokens, 350 unmerged, rework 1, touches 3, cycle 14h over 2 samples.
- Old ledger comments parse unchanged; new ones round-trip -> TestLedgerOldV1CommentHasNoAttempts, TestLedgerAttemptRowsRoundTrip, TestDecodeSpendDropsBadAttemptRowsOnly, and the existing TypeScript fixture test -> done. The marker has no version string at ts-final, and the TS reader ignores unknown keys, so I added an optional `attempts` field instead of a `v2`.
- Store rebuild test still passes; the new tables survive rebuild from the tracker -> TestRebuildMatchesLive (unchanged, green), TestReportTablesSurviveRebuildFromTracker -> done. Dump now includes the three new tables.
## API change requests
- Add an optional `Thread(ctx, id) (Thread, error)` read to the tracker ports (first dispatch time, merge time, chatops command count, manual push count). The store defines `store.Threader` for it today; no tracker implements it, so merge time and touch counts stay empty until one does.
- Something live (reconcile or observe) must call `Store.RecordThread` when it sees a merge or a human touch. Nothing outside tests calls it yet.
- A real `report.Ledger` implementation over the tracker thread (reading `<!-- factory:spend -->` comments through `meter.DecodeSpend`) is not written; the interface is in `internal/report/storesource.go`.
## Files outside my area
None. `internal/store/store.go` has the smallest change (schema concat, PutTicket calls putMeta, Rebuild reads the thread, Dump lists new tables). An existing meter test compared `Spend` with `!=`, which a slice field breaks, so I changed that one assertion.
## Gate evidence
`just` is not installed; I ran the recipe bodies by hand: `test -z "$(gofmt -l .)"` ok, `go vet ./...` ok, golangci-lint v2.13.2 under go1.26.7: `0 issues.` / `exit 0`, `go test -race ./...`: 41 packages `ok`, `exit 0`, `CGO_ENABLED=0 go build ./cmd/factory` ok, binary deleted.
## Learnings
- Importing report from store creates a cycle once report imports store; the store returns its own row type and report converts. A brief that names `StoreSource{Store, ...}` should say which side owns the row type.
- The first `go test` downloads the whole module graph and passes 120 s; start it in the background at setup.
- Bite check done by breaking code once each (revert after): ledger fill, Rebuild thread read, ledger attempts encoding, merged_at column. Each turned its tests red.
- Window limit: spend rows carry no time, so a ticket with spend is returned whatever the window.
