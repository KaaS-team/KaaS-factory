You are one of twenty-three agents working in parallel. Nine of you work on branch `next` of KaaS-team/KaaS-factory (the Go v9 factory), each in your own packages; the rest work in playbooks, solutions, auditor and blueprint. Stay inside your area.

## Ticket: prove factory-mcp, factory-plane and factory-install are superseded

Three public repos are about to be archived: KaaS-team/factory-mcp (TS MCP server over v8 routes), KaaS-team/factory-plane (cockpit PWA), KaaS-team/factory-install (install.sh, npm launcher). Before that, the Go factory must do everything they do that still matters.

Setup extra: `git clone https://github.com/KaaS-team/factory-mcp /tmp/fm`, same for factory-plane and factory-install (public). If a clone fails, say so and work from the names in this ticket.

Work:
1. List every tool in factory-mcp, every screen and action in factory-plane, every flag in factory-install's `install.sh`.
2. For each, find the Go equivalent (`internal/mcp`, `internal/dashboard`, `install/install.sh`) or mark it missing.
3. Port each missing item that still applies to v9 (a read-only board is the v9 rule: no remote control actions, no phone relay). Mark the rest "dropped by design" with the plan's reason.

## Acceptance

- [ ] The report holds the parity table: item, Go equivalent or ported-in-this-branch or dropped (reason).
- [ ] Every ported item has a test.
- [ ] `install/install.sh` keeps sha256 verification; its test covers any flag you port.

## Lessons from earlier waves (apply them)

- `just` is not installed in the cloud image. Run the recipe bodies by hand, and gate formatting with `test -z "$(gofmt -l .)"`, because `gofmt -l` exits 0 even when it lists files.
- The first golangci-lint run downloads the module graph and can pass a 120 s tool timeout. Start it in the background, write output to a file, and wait for it.
- Delete any binary your build check leaves in the tree (`rm -f factory`); never commit it.
- If a test passes the first time because the code already behaves, prove it bites by breaking the code once (revert after) and say so in the report.
- Do not raise the `go` directive in go.mod above 1.26.0.
- `cmd/factory/control.go` holds `notConfiguredSource` and `notConfiguredQueue`; the supervisor swaps in your constructor after merge. Do not edit `cmd/`.

## Setup

1. `git fetch origin && git checkout -b go/fold-satellites origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`install/`, `internal/mcp/`, `internal/dashboard/` (only to port a missing capability)

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Nine sessions build on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/fold-satellites`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-fold-satellites"
```

Your final message is then that same report, exactly:

```
BRANCH: go/fold-satellites
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
