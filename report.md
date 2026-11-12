BRANCH: go/logs
HEAD: 2b78d4660488016756681156c31ad82b9f00f851
## Summary
Added `internal/logs`: `NewCommand(Resolver)` (`logs <ticket> [-f] [--json]`), a routines run-log source, a local file-tail source, and token redaction. One commit, signed off; the PR was not opened, as the brief says.
## Acceptance
- Routines run log from httptest prints expected lines (golden) -> TestRoutinesRunLogGolden -> done
- Follow over three polls with overlapping pages prints each event once and stops at run end -> TestFollowOverlappingPagesPrintsOnce -> done
- Local mode tails a growing file in a temp dir -> TestLocalTailsGrowingFile -> done
- Token-shaped string in a log line is redacted -> TestRedact, TestPrintRedactsBothFormats -> done
Proof tests bite: the tests passed first time because I wrote code first. I then broke the code four ways, and each turned a test red, then reverted: dedupe off (follow test), gh token regex broken (redact tests), half-line hold off (local test), done flag off (follow test).
## API change requests
- The routines client has no run-log call, and the local dispatcher keeps no output file (it only scans stdout for usage). I assumed `GET /v1/code/sessions/{id}/events?after=<cursor>` answering `{"data":[{"id","time","kind","text"}],"next","has_more","status"}`, like the rest of the unconfirmed routines shapes. The local dispatcher should tee stdout to a per-session file and expose its path and an "ended" check (Wait exists), to feed `logs.Local`.
- Ticket says `logs.NewCommand()`; with no arguments it cannot reach anything, so it takes a `Resolver`. `logs.Backends` builds one from a "latest session for ticket" func and a factory per dispatcher name. The supervisor must supply the lookup; `api` has no session-by-ticket read (Observation has no session id).
## Files outside my area
none
## Gate evidence
`just` is missing, so I ran the recipe bodies by hand: `test -z "$(gofmt -l .)"` and `go vet ./...` clean; golangci-lint v2.13.2 (GOTOOLCHAIN=go1.26.7) "0 issues."; `go test -race ./...` all ok (internal/logs ok); `CGO_ENABLED=0 go build ./cmd/factory` ok, binary deleted. No `skills-ref` or `just fast` run. The first lint run found 4 issues (errorlint x3, staticcheck x1), now fixed.
## Learnings
- The `a && b && (c)&` chain backgrounds the whole chain; background the lint command alone, with output to a file.
- The brief should say what endpoint and file the run log comes from; neither exists in the routines or local code.
- Redaction regexes live in TS `src/mc/redact.ts`; the brief should name that file, since `internal/gate` has none.
