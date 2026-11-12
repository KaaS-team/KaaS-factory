You are one of twelve agents working in parallel. Ten of you build the Go v9 factory on branch `next` of KaaS-team/KaaS-factory, each in your own packages. Stay inside your area.

## Ticket: plan + intent (goal to ticket DAG)

`factory plan "<goal>"` turns a goal or spec into tickets with declared `Files:`, a dependency DAG and waves, so overlap is caught before dispatch.

Read first: TS `src/intent/pipeline.ts`, `src/intent/spec.ts`, `src/intent/tickets.ts`, `src/orchestrate/groom.ts` (planned body v1), `src/orchestrate/problems.ts`, `src/plan-deps.ts`, `src/area-locks.ts`. Playbooks spec 404. The planned body marker is `<!-- factory:planned v1 -->` with headings `## Why`, `## Change`, `## Tests`, `## Acceptance`, `## Files`.

Design to follow:
- `internal/plan`: parse and render the planned body v1 byte compatible with `groom.ts`. Build a DAG from `depends` lines. `Waves()` groups tickets so no two in a wave depend on each other or share a file or area lock. `Problems()` returns cycles, duplicates, missing `Files:`, missing acceptance and unknown dependencies, in the same wording as `problems.ts`.
- `internal/plan/intent`: goal to spec to tickets. The model call goes through an interface you define (`Drafter`), faked in tests with fixed output; no model is called in this package's tests. Its output is validated by `Problems()` and rejected when any problem exists.
- Another session owns `internal/pick` (area locks at dispatch time). Do not import it; a shared helper you need goes in your package.

## Acceptance

- [ ] Planned body: each TS fixture (`tests/fixtures/planned-issue.md` and those in `tests/` for groom) parses and re-renders to the same bytes.
- [ ] DAG: a cycle, a duplicate ticket and an unknown dependency each give the TS wording from `problems.ts` (table test).
- [ ] Waves: two tickets sharing a file never land in the same wave; a chain of three gives three waves; independent tickets share one wave.
- [ ] Intent: a fake `Drafter` returning a spec with a missing `Files:` is rejected with that problem; a valid one yields tickets whose bodies parse as planned v1.

## Setup

1. `git fetch origin && git checkout -b go/plan origin/next`.
2. `go version`. If it is older than 1.25, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand (`gofmt -l`, `go vet ./...`, golangci-lint v2.13.2 through `go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`) and say so in the report.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. Specs live in KaaS-team/playbooks. If it is not checked out next to this repo, `git clone --depth 1 https://github.com/KaaS-team/playbooks ../playbooks`. `research/symphony-spec.md` is the scheduler contract; cite its section numbers in test names or comments.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/plan/` and `internal/plan/intent/`.

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Ten sessions build on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/plan`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-plan"
```

Your final message is then that same report, exactly:

```
BRANCH: go/plan
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
