You are one of six agents working in parallel. Four of you build the Go v9 factory on branch `next` of KaaS-team/KaaS-factory, each in your own packages. Stay inside your area.

## Ticket: reconcile + pick

The orchestrator's brain: one level-triggered loop that reads the world and decides what to do, and the picker that fills free slots. Nothing here talks to GitHub or a session directly; it uses the `api` ports.

Read first: Symphony §7 (claim states, terminal reasons), §8.1 (tick order), §8.4 (backoff), §8.5 (stall and terminal reconciliation), §14 (restart recovery), §17 (test matrix). Playbooks specs 402 (`specs/402-orchestrate-pick.md`) and 405. TS sources: `src/orchestrate/pick.ts` (rankReady, planRefill), `src/area-locks.ts`, `src/blockers.ts`.

Design to follow:
- `internal/reconcile`: a pure `Decide(state State, obs []api.Observation, now time.Time, cfg Config) []Action` and a `Run(ctx, ...)` loop that ticks every `cfg.Tick` (default 30s), calls `Decide`, and applies actions through the ports. Actions are plain values (`Dispatch`, `Steer`, `Retry`, `Cancel`, `MarkDone`, `NeedsHuman`). Completion comes from the observation (branch pushed, report present, PR open), never from session status.
- `internal/pick`: `Rank(ready []api.Ticket) []api.Ticket` (priority, then oldest, then id) and `Refill(free int, ranked []api.Ticket, running []api.Ticket, locks Locks, firesLeft int) []api.Ticket`.
- Area locks: a ticket whose declared `Files` overlap (same path or one is a directory prefix of the other) with a running ticket is skipped this tick, not dropped. A ticket with an unmerged `BlockedBy` is skipped.

## Acceptance

- [ ] `Decide` follows Symphony §8.1 tick order; a table test has one row per §17 case you can express without a network (claim, running, stalled, retry with backoff, terminal, needs-human, canceled).
- [ ] Backoff is `min(10s * 2^(n-1), 5m)` per attempt n (§8.4); a test pins attempts 1 to 7.
- [ ] Stall: no push within `StallAfter` gives exactly one `Steer`; still no push at twice `StallAfter` gives `Retry`; after `MaxAttempts` gives `NeedsHuman`.
- [ ] A pushed branch with no report counts as still running, not done.
- [ ] `Refill` never returns more tickets than `min(free, firesLeft)`, never two tickets whose `Files` overlap, never one whose `Files` overlap a running ticket, and never a blocked ticket.
- [ ] Restart: given only a fake Tracker and Observer (no prior state), one `Decide` pass rebuilds the same running set as before the restart (§14). Test it by running a scenario, dropping state, and comparing.
- [ ] `Run` stops when its context is cancelled and makes no call after that (test with porttest fakes and a short tick).

## Setup

1. `git fetch origin && git checkout -b go/reconcile origin/next`.
2. `go version`. If it is older than 1.25, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand (`gofmt -l`, `go vet ./...`, golangci-lint v2.13.2 through `go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`) and say so in the report.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. Specs live in KaaS-team/playbooks. If it is not checked out next to this repo, `git clone --depth 1 https://github.com/KaaS-team/playbooks ../playbooks`. `research/symphony-spec.md` is the scheduler contract; cite its section numbers in test names or comments.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/reconcile/`, `internal/pick/`.

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Four sessions build on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/reconcile`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-reconcile"
```

Your final message is then that same report, exactly:

```
BRANCH: go/reconcile
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
