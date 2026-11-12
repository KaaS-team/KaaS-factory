TICKET: m4-absorb
NEXT: d1828c495e0467559341e84311dccc500725e99b
## Built
- Control methods (CreateTicket, HandOff, QueueFollowup, Repos) -> d0122b0; core_test TestControlTicketWrites, TestCreateTicketNeedsAFilingTracker
- create_task, hand_off_task, queue_followup, list_events, list_repos -> b607d6a; TestPortedToolsKeepTSDescriptionAndAnnotations, TestPortedToolsRejectEmptyRequiredInputs, TestOptionalInputsMayBeLeftOut, TestListEventsAndListRepos, TestCreateTaskReturnsTheNewID, TestEveryTSToolIsServed (structural; maps list_tasks->list_tickets, get_task->status, get_metrics->status, spend->report), TestEachToolCallsMatchingControlMethod and the existing sweeps extended to 17 tools
- HTTP transport `factory mcp --http <addr>` -> 5ab6d94; TestHTTPAuthAndPaths (9 cases), TestHTTPClientListsToolsAndCalls, TestHTTPEmptyTokenIsRefused, TestBindAddr, TestHTTPCommandServesWithEnvToken, TestTokenIsEnvOnlyAndComparedInConstantTime
- Ratchet and docs/cli-reference.md refresh -> a351984; lint fixes b9b6706; merge d1828c4
- TS cases covered: http.test.ts 5 of 5 (the single-line source check is ported as a constant-time/no-== source test, and the bin env/--http check as a flag/env test). contract.test.ts 0 of 3 directly: it checks the TS HTTP client's routes against an OpenAPI fixture, and the Go server has no HTTP client. Its purpose, a tool dropped or drifting from the core, is covered by TestEveryTSToolIsServed and TestEachToolCallsMatchingControlMethod (every tool maps to one Control method).
## Bite checks
- TestListsExactlyTheFactoryTools -> mcp_test.go:112: unexpected tool "list_repos_x" (tool dropped from the registry)
- TestPortedToolsKeepTSDescriptionAndAnnotations -> hand_off_task hints (readOnly, destructive, idempotent, openWorld) = [false false true false], want [false true true false]
- TestPortedToolsRejectEmptyRequiredInputs -> create_task map[title:]: accepted (check removed)
- TestHTTPAuthAndPaths -> no token: status 200, want 401 (token check disabled); other path, right token: status 200, want 404 (path check removed)
- TestHTTPEmptyTokenIsRefused -> Handler accepted an empty token; err = <nil>
- TestBindAddr -> BindAddr(":8080") = "0.0.0.0:8080", want "127.0.0.1:8080"
- TestHTTPCommandServesWithEnvToken -> token in the log: "mcp: serving http://127.0.0.1:43419/mcp token secret-token"
- TestControlTicketWrites -> comments = [... "also this"], want [... "Follow-up: also this"]
## Control changes
- CreateTicket(ctx,title,body): Control had no write that files a ticket; core uses the tracker's existing Create (GitHub), a tracker without it refuses.
- HandOff(ctx,id,to,note): no assignee write exists on Tracker; core posts a thread comment through Tracker.Comment and emits handed_off. It records the hand-off, it does not set a tracker assignee, so the TS wording "replaces the current assignee" is carried over unchanged but is only as true as the thread record.
- QueueFollowup(ctx,id,message): Steer needs a running session; core posts "Follow-up: ..." to the thread via Tracker.Comment and emits followup.
- Repos(ctx): core returns its configured repo (cfg.Team); no existing method lists repos.
- Each has a porttest fake method (recorded as calls) and the cmd/factory test fake; the real implementation is core.Core, already wired by the CLI. Events kinds created, handed_off, followup added on the existing hub.
## Left out
- `spend`: covered by the operator-only `report` tool, not added.
- list_tasks/get_task/get_metrics: map to list_tickets/status; no new tools.
- A tracker assignee write and a thread read of follow-ups by the next brief (not verified here): out of scope.
- No flags beyond --http. TS contract.test.ts HTTP-client route test has no Go counterpart (no client).
## Gate evidence
go_lines 41725 (baseline 41725), deadcode 408 (baseline 408)
exit 0   (./gate.sh after the last push, all packages ok)
Ratchet: raised by hand (go_lines +291 mine, deadcode +4 = the four porttest fake methods, which are test-only code in a non-test file); reason line updated; conflict with origin/next resolved by taking larger values and re-measuring.
## Learnings
- Go 1.24 host needs GOTOOLCHAIN=auto for the 1.26 module.
- Control additions break any non-embedding test fake (cmd/factory fakeControl).
- go-sdk annotation hints default destructive/openWorld to true, so they must be set explicitly.
- errcheck lint in the gate flagged deferred Close and Fprintf; run golangci-lint before the first gate run.
- A "refuses an empty token" test must have a context timeout or a broken command serves forever.
