You are one of twelve agents working in parallel. Ten of you build the Go v9 factory on branch `next` of KaaS-team/KaaS-factory, each in your own packages. Stay inside your area.

## Ticket: gate + observe + store

The pieces that tell the reconcile loop what is true: the gate result of a branch, the observation of a ticket on GitHub, and a cache that can be rebuilt from nothing.

Read first: TS `src/gates.ts` (the `FACTORY_GATES:` line), `src/derive.ts` and `src/rehydrate.ts` (how state is rebuilt from the issue thread), `src/adapters/sqlite/store.ts`. Symphony spec §8.5 (stall and terminal reconciliation) and §14 (restart from tracker plus filesystem).

Design to follow:
- `internal/gate`: run a gate command with a context deadline in its own process group (kill the group on timeout), capture the tail of output, parse `FACTORY_GATES: status=... passed=N failed=N skipped=N failed_gates=a,b` byte compatible with `src/gates.ts`. A missing line counts as a fail. A timeout counts as a fail with reason timeout.
- `internal/observe`: implements `api.Observer`. Given a ticket, it reads (through a narrow interface you define, faked in tests) the branch `factory/<ticket>-a<n>`, the `report/<ticket>` branch, the PR and its checks, and returns `api.Observation`. Pushed without a report counts as running; report plus open PR counts as done; checks red sets `ChecksGreen=false`.
- `internal/store`: `modernc.org/sqlite` (pure Go, `CGO_ENABLED=0`). Tables for tickets, sessions, events and spend. The store is a cache: `Rebuild(ctx, tracker, observer)` from an empty file gives the same rows as the live one.

## Acceptance

- [ ] Gate parse: table of TS fixture lines (green, red with failed_gates, skipped, malformed, missing) gives the same result as `src/gates.ts`.
- [ ] Gate run: a command that sleeps past the deadline is killed with its children (check the child pid is gone) and reported as a timeout fail.
- [ ] Observe: table test over branch, report, PR and checks combinations, one row per phase outcome.
- [ ] Store: delete the database, `Rebuild` from the fakes, and the rows equal the rows before deletion.
- [ ] `go build` with `CGO_ENABLED=0` still passes with the sqlite dependency.

## Setup

1. `git fetch origin && git checkout -b go/gate-observe-store origin/next`.
2. `go version`. If it is older than 1.25, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand (`gofmt -l`, `go vet ./...`, golangci-lint v2.13.2 through `go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`) and say so in the report.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. Specs live in KaaS-team/playbooks. If it is not checked out next to this repo, `git clone --depth 1 https://github.com/KaaS-team/playbooks ../playbooks`. `research/symphony-spec.md` is the scheduler contract; cite its section numbers in test names or comments.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/gate/`, `internal/observe/`, `internal/store/`.

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Ten sessions build on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/gate-observe-store`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-gate-observe-store"
```

Your final message is then that same report, exactly:

```
BRANCH: go/gate-observe-store
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
