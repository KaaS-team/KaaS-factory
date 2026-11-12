You are one of six agents working in parallel. Four of you build the Go v9 factory on branch `next` of KaaS-team/KaaS-factory, each in your own packages. Stay inside your area.

## Ticket: tracker-github + gitx

The GitHub tracker is the system of record (the issue thread is the only state), and gitx gives the git operations the orchestrator and merge queue need.

Read first: TS sources `src/derive.ts` and `src/rehydrate.ts` (the `<!-- factory:data {...} -->` and `<!-- factory:status v1` markers), `src/trust.ts`, `src/chatops.ts` (`/factory approve|revise|retry|cancel`), `src/labels.ts`, `src/engine/pr-body.ts`, `src/adapters/git-lease/lease.ts`. Issue #210: the PR footer names no model and no cost.

Design to follow:
- `internal/tracker/github`: implements `api.Tracker` over an injected HTTP client (go-github `github.com/google/go-github/v7x` latest is fine; pin it). Ready = open issues with the `factory:ready` label (port label names from `src/labels.ts`). Marker codec for `factory:data` and `factory:status v1`, byte compatible with the TS one. Chatops parser with the trust rules from `src/trust.ts`. A PR body renderer ported from `src/engine/pr-body.ts`.
- `internal/gitx`: thin wrappers over the `git` binary (no libgit2): `MergeTree(base, a, b) (conflicts []string, err)` using `git merge-tree --write-tree`, `DiffNames(base, head)`, `FFPush`, and lease refs (`refs/factory/lease/<name>`) with compare-and-swap through `git update-ref <ref> <new> <old>` and `git push --force-with-lease`.

## Acceptance

- [ ] Marker codec: each TS marker fixture decodes and re-encodes to the same bytes (golden table).
- [ ] Chatops: a command from an untrusted author is ignored; each of approve, revise, retry, cancel from a trusted author parses (table test).
- [ ] PR body: no model name, token count, cost or `claude.ai` link appears, for every input in the table (#210).
- [ ] Tracker: `Ready`, `Get`, `Comment`, `SetPhase` against an `httptest.Server` with recorded goldens; `SetPhase` swaps labels, it never removes labels it does not own.
- [ ] gitx: in a temp repo, two branches editing the same line report the file as a conflict, and two branches editing different files report none.
- [ ] Lease CAS: two takers of the same lease ref with the same old value, exactly one wins (test against a local bare remote).

## Setup

1. `git fetch origin && git checkout -b go/tracker origin/next`.
2. `go version`. If it is older than 1.25, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand (`gofmt -l`, `go vet ./...`, golangci-lint v2.13.2 through `go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`) and say so in the report.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. Specs live in KaaS-team/playbooks. If it is not checked out next to this repo, `git clone --depth 1 https://github.com/KaaS-team/playbooks ../playbooks`. `research/symphony-spec.md` is the scheduler contract; cite its section numbers in test names or comments.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/tracker/github/`, `internal/gitx/`.

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Four sessions build on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/tracker`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-tracker"
```

Your final message is then that same report, exactly:

```
BRANCH: go/tracker
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
