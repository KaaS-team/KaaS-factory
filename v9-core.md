You are one of twenty agents working in parallel. Eighteen of you build the Go v9 factory on branch `next` of KaaS-team/KaaS-factory, each in your own packages; one works in auditor and one in blueprint. Stay inside your area.

## Ticket: core, the one api.Control

Nothing implements `api.Control` yet. Build it: the object every client (CLI, TUI, MCP, dashboard) talks to. It owns one reconcile loop and turns its decisions into calls on the ports, and it publishes every change as an `api.Event`.

Read first: `internal/reconcile` (Decide and Run), `internal/pick`, `internal/mergeq`, `internal/store`, `internal/meter`, `internal/observe`, and Symphony §7, §8.1, §13 in the spec (setup step 5).

Design to follow:
- `core.New(Deps) (*Core, error)` where `Deps` holds the ports (`api.Tracker`, `api.Dispatcher`, `api.Observer`), the store, the meter, a merge queue and a clock. No package-level state.
- `Run(ctx)` ticks on the configured interval in Symphony §8.1 order and stops when ctx ends.
- `Board`, `Dispatch`, `Steer`, `Cancel`, `Retry` and `Events` implement `api.Control`. `Events` fans out to every subscriber; a slow subscriber is dropped with a `subscriber_dropped` event, never blocks the loop.
- Event kinds are constants in this package and documented in `events.go`: tick, dispatched, steered, canceled, retried, stalled, pushed, gate, queued, merged, needs_human, budget, subscriber_dropped.
- When the tracker implements `api.Lister`, startup rebuilds from it (Symphony §14); otherwise from `Ready`.

## Acceptance

- [ ] A compile-time assertion `var _ api.Control = (*Core)(nil)`.
- [ ] With porttest fakes and a fake clock: three ready tickets and 2 slots dispatch two, and the third dispatches after one merges. Events arrive in that order.
- [ ] Manual `Dispatch`, `Steer`, `Cancel`, `Retry` each reach the dispatcher once and emit one event; `Retry` raises the attempt number.
- [ ] A subscriber that never reads is dropped after a bounded buffer and the loop keeps ticking (test with `-race`).
- [ ] Restart: a new Core over a tracker implementing `api.Lister` shows the running ticket on the board without dispatching it again.

## Setup

1. `git fetch origin && git checkout -b go/core origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/core/`

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Eighteen sessions build on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/core`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-core"
```

Your final message is then that same report, exactly:

```
BRANCH: go/core
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
