BRANCH: go/k8-spend-cap
HEAD: 5b3735bc52acf0ed8f14ca4c807bd1149a1a9301
## Summary
Added `internal/meter/cap`: a Gate that reads a ticket's spend from the ledger comment, writes a `factory:cap v1` marker (cap and spend) beside it, and returns ErrOverCap (no cost, count or model in its text) when spend has reached the cap. Core calls it before every dispatch. Nothing in the repo is wired to set the cap yet (see API change requests).
## Acceptance
- A session over its cap is refused before dispatch with a clear reason -> cap_test TestAllow (5 branches), TestRefusalNamesNoCost, core TestSessionCapRefusesBeforeDispatch (dispatcher never called) -> done
- Cap and spend are written to the ledger -> TestLedgerWritten, TestLedgerAddKeepsCap, core test checks the marker -> done
- Test covers concurrent sessions -> TestConcurrentSessions (40 tickets in parallel, run under -race) -> done
Bite-checks (revert, watch red, restore): `>=` to `>` fails TestAllow; skipping the ledger write fails TestLedgerWritten and TestLedgerAddKeepsCap; dropping marker preservation in Ledger.Add fails TestLedgerAddKeepsCap; removing the core admit call fails the core test; ignoring the holder filter initially survived, so I added TestOtherHolderIgnored and it then failed. The concurrency test has no bite-check: its tickets are independent, so no single revert breaks it.
Interpretation: "session" is the ticket's run (all attempts), since the ledger keeps spend per ticket and holder. Spend counts rows with the team as holder and no day.
Found already there: meter.Meter budgets (node, ticket, team-day, steer/stop in meterPass), the spend ledger (Ledger, EncodeSpend/DecodeSpend), tutor tier policy. The new piece is the pre-dispatch refusal; meterPass only stops a session after the fact. Tutor routing was not touched. Not ported: no upstream code was copied, so no THIRD_PARTY_NOTICES change.
## API change requests
- Wire `Config.SessionCap` in `cmd/factory/control.go` (next to `Budget: api.Budget{USD: c.Budgets.Ticket}`) from a new config value. Until then the cap is 0 (off), and the gate is reachable only through core.New.
- A refused dispatch surfaces as an error from Core.Dispatch and from the reconcile dispatch path; reconcile will retry each tick. A parked/needs-human transition on ErrOverCap would be cleaner, in core or reconcile.
## Files outside my area
- internal/core/core.go, control.go, ports.go and a new spendcap_test.go: the smallest pre-dispatch hook (Config.SessionCap, admit, two call sites).
- internal/meter/thread.go: Ledger.Add now keeps cap markers when it rewrites the comment; without it the cap marker was dropped on the next usage write.
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt clean, `go vet ./...` and `-tags ee` clean, `go test -race ./...` and `-tags ee` all ok, `CGO_ENABLED=0 go build ./cmd/factory` built, golangci-lint v2.13.2 on internal/meter and internal/core: "0 issues." (I did not lint the whole repo.)
Non-test Go lines (non-src): 21276 before, 21394 after (+118). Deadcode lines: 70 before, 70 after (the count includes go download noise lines on the first run).
## Learnings
- `just` missing in the cloud image; the justfile bodies run by hand fine.
- Ledger.Add rebuilds the whole comment from decoded spend markers, so any new marker needs preservation there; a shared "keep unknown markers" step would remove that trap.
- Package named `cap` shadows a builtin; lint did not object, but the directory name forced it.
