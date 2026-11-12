You are one of six agents working in parallel. Four of you build the Go v9 factory on branch `next` of KaaS-team/KaaS-factory, each in your own packages. Stay inside your area.

## Ticket: dispatch (routines, fire, local) + meter

Dispatchers start and steer coding-agent sessions; the meter turns their usage into budgets and a spend ledger. Each dispatcher implements `api.Dispatcher`.

Read first: playbooks specs 400, 401, 403; Symphony §13.5 (token accounting: absolute totals, derive deltas, never double count). TS sources: `src/agents/presets/claude.ts` (argv, pinned byte for byte by `tests/agents.test.ts`), `src/cloud/port.ts`, `src/cloud/claude.ts`, `src/adapters/github-store/spend.ts` (the `<!-- factory:spend v1 -->` ledger).

Design to follow:
- `internal/dispatch/brief`: renders an `api.Brief` to markdown and names it `v9-<ticket>-a<attempt>.md`. The session prompt is `git show origin/cloud-briefs:<name>` then follow it.
- `internal/dispatch/routines`: HTTP client for `POST /v1/code/triggers` (create, `enabled:false`, no cron) then run, and `GET /v1/code/sessions` to watch. Base URL and auth token are injected; tests use `httptest.Server` with recorded request goldens. The session key `factory-<ticket>-a<attempt>` is idempotent: a second Dispatch with the same key finds the existing trigger instead of creating another.
- `internal/dispatch/fire`: `POST /v1/claude_code/routines/{id}/fire` with body `{"text": "<brief name>"}`; enforce 30 fires per hour per routine and 100 per account with an injectable clock.
- `internal/dispatch/local`: runs an agent CLI in a worktree from an argv preset. The claude preset must produce the same argv as `src/agents/presets/claude.ts` for the same inputs (port its test cases). Process-group kill on cancel.
- `internal/meter`: `Record(key, api.Usage)` with absolute totals, derived deltas, per-node, per-ticket and per-team-day budgets. `Check` returns `ok`, `steer` at 80% and `stop` at 100% of the tightest budget. A ledger codec for the `<!-- factory:spend v1 -->` comment, byte compatible with the TS one.

## Acceptance

- [ ] Routines: create and run requests match recorded goldens; the same key twice creates one trigger.
- [ ] Fire: the 31st fire within an hour for one routine, and the 101st for the account, return a rate error without an HTTP call; the window slides with the fake clock.
- [ ] Local: the claude argv for each case in `tests/agents.test.ts` matches byte for byte; cancel kills the whole process group (test with a shell child that spawns a grandchild).
- [ ] Meter: feeding the same absolute total twice adds zero; a total that goes down is an error; deltas sum to the last total (§13.5 table test).
- [ ] Budgets: 79% is ok, 80% is steer, 100% is stop, for node, ticket and team-day levels.
- [ ] Spend ledger: decode the TS fixture comment, encode it back, bytes equal.
- [ ] No dispatcher puts an `ANTHROPIC_*` variable in a child env or request; a test scans the env passed to the local runner and every recorded request.

## Setup

1. `git fetch origin && git checkout -b go/dispatch origin/next`.
2. `go version`. If it is older than 1.25, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand (`gofmt -l`, `go vet ./...`, golangci-lint v2.13.2 through `go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`) and say so in the report.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. Specs live in KaaS-team/playbooks. If it is not checked out next to this repo, `git clone --depth 1 https://github.com/KaaS-team/playbooks ../playbooks`. `research/symphony-spec.md` is the scheduler contract; cite its section numbers in test names or comments.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/dispatch/` (all subpackages), `internal/meter/`.

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Four sessions build on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/dispatch`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-dispatch"
```

Your final message is then that same report, exactly:

```
BRANCH: go/dispatch
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
