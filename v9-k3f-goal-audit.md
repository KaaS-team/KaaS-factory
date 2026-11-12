You are one of 10 agents working in parallel: 5 wire or shed slices of the factory on `next`, 1 audits it against the plan, 4 shed the satellite repos. Stay inside your area. Where your area grants an existing package or a cmd file, that grant overrides the general never-edit rule in the common section. Several sessions add one line to `cmd/factory/main.go` or `internal/core`; keep such edits to the fewest lines so the supervisor can merge them.

## Ticket: audit the factory against its plan

The plan is on the brief branch: `git show origin/cloud-briefs:plan.md`. Read section 2 (design), section 4 (verification) and the
tokenomics, proof and first-run parts. Then read `next` and answer, with file:line evidence for each:

1. Which plan features exist and are reachable from a command, which exist but are unreachable, and which are missing.
2. Which code is not in the plan at all (scope creep), with its size in lines.
3. Where two implementations of one concept exist.
4. The five changes that would bring the binary closest to the plan for the fewest lines, ranked.
5. PR and commit quality on `next` since tag `ts-final`: tests that test nothing (no assertion that can fail), mocks of the code under
   test, comments that claim what the code does not do. Give at most ten, worst first.

Do not edit any file and do not push any branch except the report branch. Under "Acceptance" list the five questions as done.

## Why this wave exists

An audit of `next` found 230 functions no product path reaches (`go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./...`). The factory's
non-test Go is about 20K lines against a plan budget of 8K. Pieces were ported and tested but never connected, so the binary does
less than the code claims. This wave makes every slice either reachable from `cmd/factory` or gone.

## The rule: wire it or delete it

For each function in your list:
1. If it serves a factory feature the plan keeps (list below) and a real command path should reach it, wire it with the smallest call
   site, and add a test that goes through that path (a command, the core loop, or the HTTP handler), not only the unit.
2. If it does not serve a kept feature, or a second implementation of the same concept already runs, delete it and its tests. One
   implementation per concept: when two exist, keep the one the live path uses unless the other is the plan's design and the live one
   is a stub, and say which you kept and why.
3. Then shrink what stays in your area: duplicated helpers become one, an interface with one implementation and no test fake becomes
   the concrete type, options nobody sets go, comments that restate the code go. Behaviour on reachable paths does not change: the
   existing tests are the contract, and you delete a test only together with the code it tests.

Kept features (the plan): issue thread as the only state (markers), chatops and trust, PR body with no cost or model (#210), reconcile
loop (Symphony 7/8), pick and area locks, plan to ticket DAG, workflow graph engine with per-node agent and tier, dispatchers routines,
fire and local, merge queue, gitx lease refs, trackers github/linear/jira, meter and spend ledger (tokenomics), packs and lock, eval,
store as a rebuildable cache, api Control and events, tui, mcp, dashboard, first-run, config layering, provenance, serve, a2a, sandbox,
tutor tiers, browser check pack, self-update and GitHub App auth.

Measure before and after: `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l` and the deadcode count for your
packages. Both go in the report.

## Lessons from earlier waves

- `just` is not installed in the cloud image; run the recipe bodies (see Setup). Gate formatting with `test -z "$(gofmt -l .)"`.
- Long checks can pass a 120 s tool timeout: run them in the background, write output to a file, and wait for it.
- If a new test passes first time, break the code once to prove it bites, revert, and say so.

## Setup

1. `git fetch origin && git checkout -b go/k3f-goal-audit origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

no code. You only read and write the report.

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Six sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k3f-goal-audit`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k3f-goal-audit"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k3f-goal-audit
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
