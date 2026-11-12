# KaaS Factory (Go, branch `next`)

Plans work into tickets and runs them on parallel coding-agent sessions (cloud routines or local
`claude -p`), then lands them through a merge queue. This branch is the v9 Go rewrite.

`src/`, `tests/`, `dashboard/`, `scripts/` and the other TS files are the frozen v8 tree (tag
`ts-final`). Read them for porting; never edit them. They are deleted at cutover.

## Stack

Go (go.mod `go 1.26.0`, which modernc sqlite needs; set `GOTOOLCHAIN=auto` if yours is older), cobra, `just`, golangci-lint
v2.13.2, `CGO_ENABLED=0`.

## Commands

- `just check`: the gate (gofmt, vet, golangci-lint, `go test -race`, static build). CI runs it
  (`.github/workflows/go.yml`) and so does the pre-push hook (`.agents/repo.json`).
- `just fast`: gofmt, vet, `go test` without race or lint. Run it before every push.

## Boundaries

- `internal/api` is the one contract: the core reaches the world only through its ports, and the
  CLI, TUI, MCP and dashboard reach the core only through `Control` and `Event`.
- A copied file starts with `// Ported from <repo>@<sha> <path>`, MIT or Apache-2.0 only, and its
  `repo@sha` gets a section in `THIRD_PARTY_NOTICES.md` (`internal/provenance` test).
- No `ANTHROPIC_*` or other provider key anywhere; sessions run under the operator's login.
- Token counts, cost and model names never go in a PR body or a customer-facing view.
- Cloud sessions cannot push `.github/workflows/**`; leave workflow changes for a local session.

## Session reports

A cloud session finishes by pushing its report (what changed, the `just check` result, what was left
out and why) as `report.md` on its own `report/<ticket>` branch. A repo hook refuses writes under
`.factory/`, so the report never lands in the tree.

## Tests

| Package | Covers |
|---|---|
| `internal/api/porttest` | fakes for every port; dispatch is idempotent per attempt |
| `internal/provenance` | notices match ported-file headers |
| `cmd/factory` | root command and `version` |
