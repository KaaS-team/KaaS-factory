You are one of about 50 agents working in parallel: 12 build slices of the factory on `next`, 8 in kaasbot, others research open source. Each build ticket below comes from a research session that read the upstream code at a pinned SHA. Your job is to copy or port the named upstream pieces (MIT or Apache-2.0 only; first line of a copied or ported file is `// Ported from <repo>@<sha> <path>`, plus a `THIRD_PARTY_NOTICES.md` section), not to redesign them. Stay inside your area.

Clone the upstream at the pinned SHA: `git clone https://github.com/<repo> /tmp/up && git -C /tmp/up checkout <sha>`. If the report left a licence question open (for example a dependency or grammar file), check it first and skip the piece if it is not MIT or Apache-2.0.

## Ticket: append-only per-ticket event log with a state checksum, replayed on restart

 Some of this may already exist on the base branch (earlier waves built nearby pieces): read the area first, keep what exists, build only the gap against the acceptance lines, and list in the report what you found already there.

## Acceptance

The acceptance lines of your ticket drafts below, each with a test. Bite-check: revert each fix once and watch its test fail; say so in the report. Anything left out is listed with the reason.

### From research report `temporal` (your tickets: #2; the others belong to other sessions)

Copy list:

| upstream path@sha | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| common/backoff/retrypolicy.go@bfabec7 | MIT | 358 | adds one retry/backoff type for dispatch fire, tracker calls, kaasbot wake | drop the `clock` dependency or use our time source; keep ExponentialRetryPolicy, ErrorDependent, Constant, jitter |
| common/backoff/retry.go@bfabec7 | MIT | 209 | adds `ThrottleRetryContext` loop with ctx cancel and retryable predicate | remove proto/durationpb helpers (lines 178-209) |
| common/backoff/jitter.go@bfabec7 | MIT | 22 | adds jitter helper | none |
| common/backoff/cron.go@bfabec7 | MIT | 73 | possibly replaces our cron next-time parsing in kaasbot wake | check it covers the cron dialect we accept |
| service/history/queues/dlq_writer.go@bfabec7 | MIT | 155 | adds a DLQ write path for poison tickets/tasks | swap persistence.QueueWriter for our store (SQLite/FTS5 or file); drop chasm and namespace |
| service/history/queues/executable.go@bfabec7 (error classification, lines about 451-720 only) | MIT | about 270 | adds terminal-vs-retryable classification and unexpected-attempt cap | rewrite against our error types; keep the structure only |
| service/history/workflow/checksum.go@bfabec7 | MIT | 91 | adds snapshot integrity check on reconcile restart | replace MutableState payload with our ticket state struct |
| common/collection/priority_queue.go@bfabec7 | MIT | 91 | replaces any hand-rolled heap in pick/rescheduler | none (generic) |
| service/history/queues/rescheduler.go@bfabec7 | MIT | 363 | adds parked-retry scheduler for throttled work | heavy rewrite; likely adapt ideas, copy only the heap-plus-timer core |

Ticket drafts:

1. area: factory/dispatch + kaasbot/wake. Goal: add a shared `retry` package forked from temporal common/backoff (retrypolicy, retry, jitter, MIT header kept, SHA pinned in a NOTICE file). Acceptance: all fire/tracker/wake retry loops use it; table tests for max attempts, expiry, jitter bounds, overflow; no new dependency on go.temporal.io.
2. area: factory/reconcile. Goal: append-only per-ticket event log plus state checksum, replayed on restart (idea from mutable_state_rebuilder.go and checksum.go). Acceptance: kill -9 the daemon mid-ticket and restart: no completed step is re-run, tokens spent after restart for completed steps equal 0; checksum mismatch triggers rebuild from log and an audit event.
3. area: factory/pick + kaasbot/run. Goal: classify task errors (retryable, terminal, rate-limited) and park poison tasks in a DLQ after N unexpected failures (from queues/executable.go and dlq_writer.go). Acceptance: a ticket failing N times stops being picked, appears in `status` and the dashboard DLQ list, and can be requeued by hand; heartbeat timeout kills a silent session before the hard timeout.

## Measures (put both in the report)

- Non-test Go lines before and after: `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l`.
- Deadcode before and after: `GOTOOLCHAIN=go1.26.7 go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./... | wc -l`.
The repo is 20357 lines against an 8000-line budget. Prefer deleting to adding. Nothing you add may be unreachable from `cmd/factory`.

## Lessons from K3 to K9

- `deadcode` and `golangci-lint` need `GOTOOLCHAIN=go1.26.7`.
- `internal/conformance` pins exported names; if you rename one, fix the three lines there and list it.
- Wiring adds lines. Delete what your change makes redundant in the same commit.

## Setup

1. `git fetch origin && git checkout -b go/k10-eventlog origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

new `internal/reconcile/eventlog/` plus the smallest hook in `internal/reconcile`

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Fourteen sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k10-eventlog`. Run `just fast` before every push and `just check` before the last one.

## Checkpoints, before every commit

1. Area: every changed file is in your area or listed under "Files outside my area".
2. Scope: the diff serves only an acceptance line below. No refactor of other packages, no extra feature.
3. Meaning: each acceptance line still means what it says. If it cannot be met, record it blocked; never weaken it.
4. Proof: you saw each new test fail before the code and pass after.
5. No network, real token or model call in any test. Fakes from `internal/api/porttest` or a local `httptest.Server` only.

## Rules

- Tests are table tests where a rule has branches; every branch of a decision function has a row.
- No `ANTHROPIC_*` or other provider key in code, tests or env. No model name, token count or cost in any PR body or customer-facing text.
- No global state, no `init()` side effects, no goroutine without a context that stops it.
- Exported names get one-line doc comments that say what the code does, nothing it does not.
- No em dashes in prose. Plain sentences.
- Do not comment on, label or close issues, and do not open a PR. Never force-push or push to `next` or `main`.
- No session URL, `claude.ai` link or `Claude-Session:` trailer in any commit or file.
- If one acceptance line is blocked, record why and continue with the next.

## When you finish

Write the report below to a file outside the repo, then push it to its own branch with these commands (the supervisor's log cuts long messages short, and a repo hook refuses writes under `.factory/`):

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k10-eventlog"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k10-eventlog
HEAD: <full sha you pushed, checked with git ls-remote>
## Summary
<one or two sentences>
## Acceptance
- <line> -> <test name> -> done | blocked (why)
## API change requests
<each, or none>
## Files outside my area
<each, with why, or none>
## Gate evidence
<last lines of `just check`, verbatim>
## Learnings
<what cost time; what the factory's defaults should do instead. One line each.>
```
