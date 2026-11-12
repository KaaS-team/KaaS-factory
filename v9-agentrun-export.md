You are one of six agents working in parallel. Five build modules of KaaS-team/kaasbot (a private Go service for 24/7 AI teammates); you work in KaaS-team/KaaS-factory on branch `next`. Stay inside your area.

## Ticket: export `pkg/agentrun` so kaasbot can import the dispatcher

kaasbot needs the factory's agent-run code: the `Dispatcher` port, the `local` dispatcher (`claude -p` under the operator's login, stream-json usage parsing, process-group kill, resume), the cloud `routines` dispatcher, and the token `meter`. Go forbids importing `internal/` from another module, so add a small public package that re-exports them. Do not move code.

## Setup

1. `git fetch -q origin && git checkout -b go/agentrun-export origin/next`.
2. `go version`; if older than 1.26 run `export GOTOOLCHAIN=auto`.
3. `just` is not installed. Run the recipe bodies in `justfile` by hand: `test -z "$(gofmt -l .)"`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...` (start it in the background and wait; the first run downloads a lot), `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory` then `rm -f factory`.
4. Read `AGENTS.md`, `internal/api/api.go`, `internal/dispatch/local/`, `internal/dispatch/routines/`, `internal/meter/`.

## Your area

`pkg/agentrun/` (new). You may add one line to `AGENTS.md`'s test table for it. Nothing else.

## Design to follow

- Type aliases, not copies: `type Dispatcher = api.Dispatcher`, and aliases for `Brief`, `Session`, `Caps`, `Usage`, and the local and routines `Config`, `Preset` types, and `meter.Meter`, `meter.Budgets`.
- Constructors that forward: `NewLocal(ctx, LocalConfig) (Dispatcher, error)`, `NewRoutines(RoutinesConfig) (Dispatcher, error)`, `NewMeter(...)` with the signatures the internal packages already have.
- A package doc comment that says the package is the stable surface for other KaaS modules and that its exports follow the internal packages.
- Nothing in `internal/` changes. If an internal type needed by the alias set is unexported, list it under "API change requests" instead of changing it.

## Acceptance

- [ ] `pkg/agentrun/agentrun_test.go` is an external test package (`package agentrun_test`) that builds a local dispatcher with a fake `claude` script on PATH and runs one Brief to completion through only `agentrun.*` names, then reads its usage through the meter.
- [ ] A compile-time assertion that `agentrun.NewLocal`'s result satisfies `agentrun.Dispatcher`.
- [ ] A test that walks the package's exported identifiers with `go/doc` and fails if any lacks a doc comment.

## Rules

- No network, real token or model call in any test. No `ANTHROPIC_*` anywhere.
- No em dashes in prose. Never edit the TS tree, `cmd/`, `internal/`, `.github/`.
- Commit with `git commit -s` and push `go/agentrun-export`. Do not open a PR, never push to `next` or `main`.
- No session URL, `claude.ai` link or `Claude-Session:` trailer in any commit or file.

## When you finish

Write the report to a file outside the repo, then:

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-agentrun-export"
```

Your final message is that same report:

```
BRANCH: go/agentrun-export
HEAD: <full sha you pushed>
## Summary
## Acceptance
- <line> -> <test name> -> done | blocked (why)
## API change requests
## Files outside my area
## Gate evidence
<last lines, verbatim>
## Learnings
```
