You are one of twelve agents working in parallel. Ten of you build the Go v9 factory on branch `next` of KaaS-team/KaaS-factory, each in your own packages. Stay inside your area.

## Ticket: eval harness and scorecard

The proof: `factory eval` runs a matrix of fixtures through a workflow with a given dispatcher and writes a scorecard. Pack upgrades and sales both cite it.

Read first: TS `tests/fixtures/` (stacks go, bun, uv, rails; splitbill; team), `src/scored-checks.ts`, `src/metrics-get.ts`, `src/finding-ledger.ts`. Symphony spec §17 and §18 (test matrix and conformance checklist).

Design to follow:
- `internal/eval`: a fixture is a directory with `fixture.yaml` (repo seed, tickets, hidden acceptance command). `Run(ctx, matrix, deps)` takes injected interfaces for dispatch, gate and hidden test, never a real model. It records per ticket: hidden tests pass, base stayed green, tokens in and out (absolute totals, Symphony §13.5, no double count), wall time, attempts, human touches.
- Scorecard as JSON (schema versioned `factory.scorecard/v1`, documented in a Go type) and markdown. Aggregates: pass rate, tokens per merged PR, median wall time, human touches per PR.
- `Compare(old, new)` returns not-worse or worse with the reason, the rule the pack upgrade loop uses: worse when pass rate drops or tokens per merged PR rise by more than a set margin (default 10%).
- Convert two existing TS fixtures (one stack, splitbill) into eval fixtures under `testdata/` as the seed set.

## Acceptance

- [ ] With a fake dispatcher that passes 3 of 4 tickets, the scorecard shows pass rate 0.75 and tokens per merged PR equal to total tokens over 3.
- [ ] Token accounting: repeated absolute usage updates for one session count once (table test).
- [ ] `Compare`: lower pass rate is worse; 5% more tokens is not worse; 15% more is worse (table test).
- [ ] Scorecard JSON round-trips and its markdown has no model name or cost field when rendered with the customer view flag.

## Setup

1. `git fetch origin && git checkout -b go/eval origin/next`.
2. `go version`. If it is older than 1.25, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand (`gofmt -l`, `go vet ./...`, golangci-lint v2.13.2 through `go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`) and say so in the report.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. Specs live in KaaS-team/playbooks. If it is not checked out next to this repo, `git clone --depth 1 https://github.com/KaaS-team/playbooks ../playbooks`. `research/symphony-spec.md` is the scheduler contract; cite its section numbers in test names or comments.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/eval/` (fixtures under `internal/eval/testdata/`).

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Ten sessions build on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/eval`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-eval"
```

Your final message is then that same report, exactly:

```
BRANCH: go/eval
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
