You are one of twenty agents working in parallel. Sixteen of you build the Go v9 factory on branch `next` of KaaS-team/KaaS-factory, each in your own packages; four work alone in auditor, blueprint, playbooks and factory-install. Stay inside your area.

## Ticket: assemble the binary

Every part exists, but `cmd/factory` wires none of it: `newControl` returns "core not wired yet" and the commands from `internal/{tui,mcp,dashboard,firstrun,upgrade,report}` are not mounted. Make `factory run` start a real loop.

Read first: `cmd/factory/*.go`, `internal/core` (New, Deps), `internal/config` (keys tracker, dispatcher, slots, workflow, budgets, stall_after), `internal/tracker/{github,linear,jira}`, `internal/dispatch/{routines,fire,local}`, `internal/observe`, `internal/store`, `internal/meter`, and each package's `NewCommand` and `WithControl` (or `WithSource`).

Design to follow:
- `newControl(cfg)` builds `core.New(core.Deps{...})`: tracker chosen by `cfg.Tracker` name, dispatcher by `cfg.Dispatcher` name, observer, store at `.factory/cache/factory.db` (created), meter, clock. Unknown names fail naming the key and the allowed values. Construction is a table `map[string]func(config.Config) (port, error)` per port so adding an adapter is one row.
- Merge queue: `core.MergeQueue` has no adapter yet (another session writes `mergeq.CoreQueue`). Use a small local no-op queue that returns an error from `Run` saying the queue is not configured, behind the same interface, so the swap later is one line.
- Mount `board` (tui), `mcp`, `dashboard`, `first-run`, `upgrade` and `report` on the root. Each command that needs Control gets it through its package's `WithControl(ctx, ctl)` in a `PersistentPreRunE`, built lazily so `version`, `doctor` and `config` never build a Control.
- `doctor`: a missing Go toolchain is a warn for users of the binary (they do not need Go), so leave it warn; add a check that the configured dispatcher's prerequisite exists (`claude` on PATH for local, a routine id for fire) as fail.

## Acceptance

- [ ] A structure test walks the root command tree and asserts every expected command exists: version, status, run, dispatch, steer, cancel, retry, queue, config, doctor, board, mcp, dashboard, first-run, upgrade, report.
- [ ] Each tracker and dispatcher name in the tables builds with a test config (fakes via httptest where an adapter needs a URL); an unknown name fails naming the allowed values.
- [ ] `factory run --headless` with a porttest-backed Deps (injected through the seam) prints NDJSON events from a real `core.Core`, not a fake Control.
- [ ] `version`, `doctor`, `config get` never construct a Control (test with a seam that fails if called).
- [ ] Doctor table test covers the new dispatcher-prerequisite row.

## Lessons from the last wave (apply them)

- `just` is not installed in the cloud image. Run the recipe bodies by hand, and gate formatting with `test -z "$(gofmt -l .)"`, because `gofmt -l` exits 0 even when it lists files.
- The first golangci-lint run downloads the module graph and can pass a 120 s tool timeout. Start it in the background, write output to a file, and wait for it.
- Delete any binary your build check leaves in the tree (`rm -f factory`); never commit it.
- If a test passes the first time because the code already behaves, prove it bites by breaking the code once (revert after) and say so in the report.
- Do not raise the `go` directive in go.mod above 1.26.0. Pin a library version below its latest if the latest needs a newer Go, and say so.

## Setup

1. `git fetch origin && git checkout -b go/assemble origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`cmd/factory/` (you own it)

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Sixteen sessions build on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/assemble`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-assemble"
```

Your final message is then that same report, exactly:

```
BRANCH: go/assemble
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
