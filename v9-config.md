You are one of twelve agents working in parallel. Ten of you build the Go v9 factory on branch `next` of KaaS-team/KaaS-factory, each in your own packages. Stay inside your area.

## Ticket: config layering

About 25 keys in `.factory/factory.yaml`, layered builtin < org < team < repo < `FACTORY_*` env < flags, where the org layer is a ceiling a lower layer cannot raise. `config explain` shows where each value came from.

Read first: KaaS-team/factory-config (clone `--depth 1` next to this repo): its README and ADRs 0001/0002 (policy is a ceiling). TS `src/config.ts` (the old 111-field config, read it to pick the keys that matter), `src/config-merge.ts`, `src/team/resolve.ts`, `src/team/explain.ts`, `src/orchestrate/config.ts`.

Design to follow:
- `internal/config` with `github.com/knadh/koanf/v2` (v2.3.6, pin it) and its yaml, env and posflag providers. A typed `Config` struct with these keys at least: repo, tracker, approval, dispatcher, slots (default 6), workflow, agents, packs, budgets (node, ticket, team_day), merge_mode, batch_size, stall_after, models (tier map). Unknown keys fail with the key path.
- Ceiling rule: for numeric budgets and slots a lower layer may lower but never raise the org value; for allow-lists a lower layer may only remove. A violation is an error naming both layers.
- `Explain(key)` returns the value and the layer that set it, and every layer that tried.
- Read `.factory/config.json` (as used in products/kaas) as a repo-layer alias when `factory.yaml` is absent.

## Acceptance

- [ ] Layering table test: each key set at each layer wins over the layer below it.
- [ ] Ceiling: a team layer raising `budgets.team_day` above org fails naming org and team; lowering it passes.
- [ ] Unknown key in any layer fails with its full path.
- [ ] `Explain("slots")` names the winning layer and the layers it overrode.
- [ ] A factory-config org YAML from its repo fixtures loads without error (copy the fixture into `testdata/` with a provenance note if needed).

## Setup

1. `git fetch origin && git checkout -b go/config origin/next`.
2. `go version`. If it is older than 1.25, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand (`gofmt -l`, `go vet ./...`, golangci-lint v2.13.2 through `go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`) and say so in the report.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. Specs live in KaaS-team/playbooks. If it is not checked out next to this repo, `git clone --depth 1 https://github.com/KaaS-team/playbooks ../playbooks`. `research/symphony-spec.md` is the scheduler contract; cite its section numbers in test names or comments.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/config/`.

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Ten sessions build on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/config`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-config"
```

Your final message is then that same report, exactly:

```
BRANCH: go/config
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
