You are one of about 50 agents working in parallel: 12 build slices of the factory on `next`, 8 in kaasbot, others research open source. Each build ticket below comes from a research session that read the upstream code at a pinned SHA. Your job is to copy or port the named upstream pieces (MIT or Apache-2.0 only; first line of a copied or ported file is `// Ported from <repo>@<sha> <path>`, plus a `THIRD_PARTY_NOTICES.md` section), not to redesign them. Stay inside your area.

Clone the upstream at the pinned SHA: `git clone https://github.com/<repo> /tmp/up && git -C /tmp/up checkout <sha>`. If the report left a licence question open (for example a dependency or grammar file), check it first and skip the piece if it is not MIT or Apache-2.0.

## Ticket: serve and call A2A v1 through a2a-go behind an AgentExecutor adapter

a2a-go is Apache-2.0 and may be a dependency. Factory side only. Some of this may already exist on the base branch (earlier waves built nearby pieces): read the area first, keep what exists, build only the gap against the acceptance lines, and list in the report what you found already there.

## Acceptance

The acceptance lines of your ticket drafts below, each with a test. Bite-check: revert each fix once and watch its test fail; say so in the report. Anything left out is listed with the reason.

### From research report `agent-protocols` (your tickets: #1; the others belong to other sessions)

Copy list:

| upstream path@sha | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| a2a-go/a2asrv (excluding taskstore inmemory) @5216340 | Apache-2.0 | 18,176 incl. subpackages (tests excluded) | adds a2a server in factory a2a and kaasbot a2a, replacing hand-written JSON-RPC/SSE handlers | import as a Go module dependency instead of copying; implement AgentExecutor over our reconcile/dispatch |
| a2a-go/a2asrv/push/sender.go @5216340 | Apache-2.0 | 259 | adds SSRF-guarded outbound HTTP for kaasbot webhook channel and factory notifications | lift ssrfGuardedTransport and isBlockedIP (about 60 lines) into a shared net helper, keep NOTICE |
| a2a-go/a2asrv/workqueue/*.go @5216340 | Apache-2.0 | about 560 | adds leased work queue to factory pick/dispatch refill and kaasbot wake | bind to our SQLite/Postgres store; drop in-memory impl in prod |
| a2a-go/a2asrv/limiter/limiter.go + internal/taskexec/limiter.go @5216340 | Apache-2.0 | 47 + see file | adds per-tenant concurrency caps for factory meter budgets | internal package: re-implement or vendor with attribution |
| a2a-go/a2acrypto/*.go @5216340 | Apache-2.0 | about 950 | adds signed agent cards for factory ee and kaasbot a2a | use as module dependency; wire keys to ee SSO |
| a2a-go/integrations/executor/a2aacp + internal/acp @5216340 | Apache-2.0 | about 3,850 | candidate replacement for our ACP run code in kaasbot run | internal/acp not importable; copy with headers or ask upstream to export; compare to our code first |
| A2UI/specification/v1_0/json/*.json @b4365c1 | Apache-2.0 | 1,217 | adds schemas for kaasbot a2ui messages and validation | embed with go:embed, validate with google/jsonschema-go (already an a2a-go dependency) |
| A2UI/skills/a2ui/SKILL.md @b4365c1 | Apache-2.0 | 88 | adds an agent prompt pack for generating A2UI | review token size before shipping, see Savings |
| ag-ui/sdks/community/go/pkg/core/events/{events,run_events,tool_events,state_events,token_usage}.go @8a951d1 | MIT | about 1,700 | adds streaming event types for console/dashboard | pulls logrus and testify; strip to stdlib; community SDK, verify against spec in docs/ |

Ticket drafts:

1. Area: factory a2a / kaasbot a2a. Goal: serve and call A2A v1 via a2a-go behind an AgentExecutor adapter. Acceptance: agent card served and signed with a2acrypto; message/send and streaming work against a2a-go's itk conformance suite; old hand-written handler deleted; interceptor writes an audit row per call.
2. Area: kaasbot gate / channels. Goal: shared SSRF-guarded HTTP client (from a2a-go push/sender.go) used by webhook channel and a2a push. Acceptance: loopback, RFC1918, link-local and 169.254.169.254 targets rejected at dial time with tests; redirect cap of the upstream value; no custom auth header forwarded across hosts.
3. Area: kaasbot a2ui / factory dashboard. Goal: validate outgoing A2UI messages against specification/v1_0/json schemas and add a token-cost eval. Acceptance: schemas embedded; invalid message rejected before send; eval records prompt tokens with and without SKILL.md and catalog; decision recorded on adopting ag-ui event names for run streaming.

## Measures (put both in the report)

- Non-test Go lines before and after: `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l`.
- Deadcode before and after: `GOTOOLCHAIN=go1.26.7 go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./... | wc -l`.
The repo is 20357 lines against an 8000-line budget. Prefer deleting to adding. Nothing you add may be unreachable from `cmd/factory`.

## Lessons from K3 to K8

- `deadcode` and `golangci-lint` need `GOTOOLCHAIN=go1.26.7`.
- `internal/conformance` pins exported names; if you rename one, fix the three lines there and list it.
- Wiring adds lines. Delete what your change makes redundant in the same commit.

## Setup

1. `git fetch origin && git checkout -b go/k9-a2a-v1 origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/a2a/` (or the existing A2A package) and its tests

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Twelve sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k9-a2a-v1`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k9-a2a-v1"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k9-a2a-v1
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
