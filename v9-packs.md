You are one of six agents working in parallel. Four of you build the Go v9 factory on branch `next` of KaaS-team/KaaS-factory, each in your own packages. Stay inside your area.

## Ticket: packs + lock + workflow graph

The factory assembles skills, agent presets, workflows and checks by reference instead of copying them. This ticket builds the resolver and lockfile, and the workflow graph engine that runs a pipeline as nodes and edges.

Read first: blueprint's `upstreams.json` (`git show origin/main:upstreams.json` in KaaS-team/blueprint, or `gh api repos/KaaS-team/blueprint/contents/upstreams.json`), which is already a lock shape: repo, sha, from, to, sha256. Symphony §5 (`WORKFLOW.md` front matter and template variables). The 18 workflows at `.factory/workflows/*.yml|md` on this branch and `docs/workflows.md` (keys uses, next, reject, revise, run, runtime) are the existing format; they must load unchanged.

Design to follow:
- `internal/packs`: `Ref` parsed from `owner/repo@sha#path` (sha optional before resolve). `Lock` (file `factory.lock`, YAML or JSON, your choice, say which) with entries: kind (skill, agent, workflow, check), ref, sha, sha256 of the fetched content, licence SPDX id, eval score (optional). A `Fetcher` interface so tests never touch the network; a `GitFetcher` that uses `git` against a local bare repo in tests.
- Licence check: MIT and Apache-2.0 pass; AGPL-*, GPL-*, CC-BY-SA-*, NOASSERTION and unknown are refused with an error naming the licence.
- `internal/graph`: nodes `agent`, `check`, `human`, `fanout`; edges `pass`, `fail`, `revise`. A loader for the existing yml/md workflows and for a Symphony-style `WORKFLOW.md`. `Next(node, outcome) (node, error)`. Rendering a prompt template with an unknown variable is an error.

## Acceptance

- [ ] `ParseRef` round-trips `owner/repo@sha#path` and rejects malformed refs (table test).
- [ ] Resolve fetches content, records sha and sha256 in the lock; a second resolve with a changed upstream file but the same pinned sha fails the hash check.
- [ ] AGPL-3.0, GPL-3.0, CC-BY-SA-4.0, NOASSERTION and an empty licence are refused; MIT and Apache-2.0 pass.
- [ ] Every one of the 18 `.factory/workflows/*` files loads into a graph with no error, and a golden test pins the node and edge list of `planned-to-pr.yml` and `bug-to-pr.yml`.
- [ ] Every entry in blueprint's current `upstreams.json` converts into lock entries (copy the file into `internal/packs/testdata/`).
- [ ] An unknown template variable in a workflow prompt fails with the variable name.
- [ ] A node marked as verify always gets `FreshSession: true` from the graph, whatever the workflow says.

## Setup

1. `git fetch origin && git checkout -b go/packs origin/next`.
2. `go version`. If it is older than 1.25, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand (`gofmt -l`, `go vet ./...`, golangci-lint v2.13.2 through `go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`) and say so in the report.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. Specs live in KaaS-team/playbooks. If it is not checked out next to this repo, `git clone --depth 1 https://github.com/KaaS-team/playbooks ../playbooks`. `research/symphony-spec.md` is the scheduler contract; cite its section numbers in test names or comments.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/packs/`, `internal/graph/`.

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Four sessions build on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/packs`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-packs"
```

Your final message is then that same report, exactly:

```
BRANCH: go/packs
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
