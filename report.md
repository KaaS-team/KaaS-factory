BRANCH: go/k6-depup-rules
HEAD: 9f2933e6258f3c0e566411eac1b757e27a06eb91
## Summary
New package `internal/packs/depup`: ordered rules, groups and collision filter; cron schedule with limits read from the tracker; release-age gate with configurable update-type routing. No model call anywhere. renovate (AGPL) was used for ideas only; no code or data copied, so no THIRD_PARTY_NOTICES change.
## Acceptance
- Ordered rules, last match wins; skipReason per dep -> TestEvaluate -> done
- Group yields one ticket -> TestTicketsGroupYieldsOneTicket, TestTicketsSkipsSkipped -> done
- Collision filter by file:dep:current -> TestEvaluate (collision, duplicate rows) -> done
- Cron + timezone schedule, minute probe, DST -> TestScheduleAllows (gap and overlap rows), TestParseScheduleErrors -> done
- automergeSchedule -> TestAutomergeAllowed -> done (decision function only; nothing calls it, see API change requests)
- Hourly and concurrent limits read from tracker, survive restart -> TestDecideOutcomes, TestDecideSurvivesRestart -> done, with a limit: the hourly count sees only tickets the tracker still lists as active, so a ticket finished inside the hour is not counted
- Outcome enum logged -> TestOutcomeStringsAreStable -> partly done: the enum and stable names exist; nothing logs it yet because wiring is outside my area
- minimumReleaseAge gate, no session for a young update -> TestGateReady, TestSplitFiresNothingForYoungUpdates -> done
- Gate shown as a status on the PR -> TestStatus -> partly done: `Gate.Status` returns the status value; posting it needs a port that does not exist
- Routing table configurable (major to agent, minor/patch deterministic) -> TestGateRoute -> done
Bite-check (revert each fix once, its test went red): last-match group override, collision filter, disabled rule, one-ticket-per-group, time zone conversion, hourly window, concurrent cap, depup label filter, gate off, unknown release date, default routing, configured routing. Two first survived (group override, label filter); I added a test row for each and both went red. Spec sections: tests cite Symphony 8.2, 8.3 and 14.3.
## API change requests
- Status port: a way to post a commit status on a PR (needed for the release-age status).
- Tracker read of recently finished tickets (or a created-since query), so the hourly limit counts finished tickets too.
- Wiring from `cmd/factory` (or the reconcile loop) to call `Evaluate`, `Decide`, `Gate.Split` and `Tickets`. I could not touch `cmd/`, so the package is unreachable from `cmd/factory` and deadcode lists it.
## Files outside my area
none
## Gate evidence
`just` is not installed, so I ran the recipe bodies by hand: gofmt clean, go vet clean, `go test -race ./...` all ok, `CGO_ENABLED=0 go build ./cmd/factory` BUILD OK, golangci-lint v2.13.2 (go1.26.7): `0 issues.`
Measures: non-test Go lines 20357 before, 20798 after (+441, including the one new package). Deadcode lines 68 before, 86 after (+18, the new exported functions with no caller).
## Learnings
- The brief's "nothing unreachable from cmd/factory" cannot hold when the area is one new package and `cmd/` is off limits; a ticket should name the one wiring file it may edit.
- `just` was missing here; the gate recipes needed a hand run and the full `go test -race ./...` plus lint took longer than the 120s tool timeout, so run them in the background.
- Mutation survivors came from a weak fixture (three tickets sharing one ID in the fake tracker); give fixtures distinct IDs.
