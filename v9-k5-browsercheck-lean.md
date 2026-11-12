You are one of about 50 agents working in parallel: 12 build slices of the factory on `next`, 8 in kaasbot, others research open source. Each build ticket below comes from a research session that read the upstream code at a pinned SHA. Your job is to copy or port the named upstream pieces (MIT or Apache-2.0 only; first line of a copied or ported file is `// Ported from <repo>@<sha> <path>`, plus a `THIRD_PARTY_NOTICES.md` section), not to redesign them. Stay inside your area.

Clone the upstream at the pinned SHA: `git clone https://github.com/<repo> /tmp/up && git -C /tmp/up checkout <sha>`. If the report left a licence question open (for example a dependency or grammar file), check it first and skip the piece if it is not MIT or Apache-2.0.

## Ticket: browsercheck: event-based settle, lean profile, token-cheap snapshot checks



## Acceptance

The acceptance lines of your ticket drafts below, each with a test. Bite-check: revert each fix once and watch its test fail; say so in the report. Anything left out is listed with the reason.

### From research report `browser-use` (your tickets: #3; the others belong to other sessions)

Copy list:

Licence is MIT for all rows. Our products are Go, so "copy" means port; embedded JS strings can be copied verbatim as Go string constants.
| upstream path@sha | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| browser_use/ax.py@dfb6a73 `PROBE_JS`, `VISIBLE_JS`, `POINT_JS`, `CENTER_JS`, `KIND_JS`, `SELECT_JS`, `DATE_JS`, `MOVED_JS`, `ACTIVE_VALUE_JS`, `VALUE_JS` | MIT | about 110 (JS constants, lines ~100-250) | adds to kaasbot browser: robust click/type preflight, change detection, visible-text filter | embed as Go consts, call via Runtime.callFunctionOn; strip the `data-browser-use-interaction-highlight` attribute name; keep MIT notice in a NOTICE file |
| browser_use/ax.py@dfb6a73 `state()`, `_capture`, `settle`, `click`, `type` logic | MIT | about 400 (lines 307-490, 490-670, 767-868) | adds to kaasbot browser: ordered AX list with new-id marks, event-based settle | port Python to Go over our existing CDP client; drop the browser-harness daemon and thread pump (use a goroutine reading CDP events) |
| browser_use/domains.py@dfb6a73 (`canonical_host`, `parse_url`, `pattern_matches`, `DomainRules`, `Guard`, `sweep`) | MIT | 475 | adds to kaasbot gate and browser: URL allowlist/denylist with IDNA and IP-literal handling | Go port; expose as a CEL function (`url_allowed(url)`) so gate policy owns the rule; keep the pattern grammar so docs carry over; add a subresource Fetch filter if we want more than the upstream guard |
| browser_use/browser/local.py@dfb6a73 `SKIP_COPY`, `copy_profile`, `_try_lock`/`sweep_stale_dirs`, `start_watchdog`, `chrome_args` | MIT | about 150 of 617 | adds to browsercheck and kaasbot browser: lean profile copy, stale-dir sweep, watchdog | Go port; our pkg/sandbox already jails processes, so only reuse the dir-sweep and flag list; review `chrome_args` flags against our sandbox |
| browser_use/repl/worker.py@dfb6a73 redaction pump (~1017-1026, 1113-1153) and `type_secret` (~853) | MIT | about 120 | adds to kaasbot gate: secret typed but never printed, domain-scoped | Go: redact on the tool result path before it reaches transcript or memory FTS |

Ticket drafts:

1. **Area: kaasbot browser tool.** Goal: add an AX-tree `state()` and preflighted `click`/`type` with change detection, ported from browser-use ax.py@dfb6a73 (MIT).
   - Embedded JS constants copied with NOTICE entry.
   - `state` returns ordered `[id] role "name"` list, headings, visible-only text, `*` for new ids, capped at a configurable max chars (default 3000).
   - Actions return exactly one of: navigated to URL / page changed / no change, and a clear error for detached, disabled, hidden, outside viewport, covered.
   - Benchmark vs current tool on 10 tasks, recording tokens per task before and after.
2. **Area: gate + browser.** Goal: port domains.py (MIT) as a Go package with a CEL function `url_allowed`.
   - Same pattern grammar, IDNA, IPv4-odd-form and IP-literal tests.
   - Navigation and main-frame requests checked via CDP Fetch; tabs on a disallowed page reset after each action.
   - Denials written to the audit log; docs state it is a guard, not a sandbox.
3. **Area: browsercheck + gate.** Goal: event-based settle, lean profile copy and secret redaction.
   - `settle` with ready/quiet/network conditions and a cap, no fixed sleeps in checks.
   - Temp profile copy skips the cache dirs listed in local.py SKIP_COPY; stale dirs swept at start.
   - `type_secret(name, id)` never prints the value; redaction applied to tool output before transcript, memory and disk; domain-scoped secrets.

### From research report `playwright-mcp` (your tickets: #3; the others belong to other sessions)

Copy list:

| upstream path@sha | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| (no code copy for the main path) run `npx @playwright/mcp@<pinned>` as an MCP stdio child | Apache-2.0 | 0 | replaces our own browser driver in kaasbot browser and browsercheck | Go side only needs an MCP client (factory already has an mcp module); pin version in packs lock |
| playwright-mcp@78eca85 config.d.ts | Apache-2.0 | 303 | adds a typed config schema we can mirror as a Go struct | translate TS types to Go struct and JSON, keep field names so upstream config files load unchanged |
| playwright-mcp@78eca85 Dockerfile | Apache-2.0 | 85 | adds a sandbox image for browser sessions (tini, deps, non-root) | align with pkg/sandbox limits, drop ACR and mirror args |
| playwright@9a82788 packages/playwright-core/src/tools/backend/context.ts (lines 442-453, 521, 602) | Apache-2.0 | about 30 | adds origin allow/block and path-root checks to gate | reimplement as Go gate rules (CEL) in front of the MCP call; copy is a logic reference, not a drop-in |
| playwright@9a82788 .../backend/context.ts (lines 157-161, 524-529) | Apache-2.0 | about 12 | adds URL param redaction and secret substitution | port regex and lookup to Go in the MCP proxy layer |

Ticket drafts:

1. Area: kaasbot browser. Goal: replace the in-house browser driver with `@playwright/mcp` (pinned) over stdio MCP. Acceptance: (a) teammate can navigate, snapshot, click, fill by ref on the eval fixtures; (b) only capabilities core-navigation, core-input, core-tabs enabled by default; (c) `browser_run_code_unsafe` and `browser_evaluate` unreachable without a gate rule; (d) old driver code removed.
2. Area: gate + browser. Goal: policy layer for browser calls. Acceptance: (a) CEL rules can allow or deny by origin and tool name; (b) secrets come from a file and the model only sees names; (c) URL params like token and code are redacted from logs and the ledger; (d) each browser side effect gets an audit record.
3. Area: browsercheck. Goal: token-cheap checks. Acceptance: (a) uses snapshot mode explicit with file output and depth limit; (b) assertions use verify tools; (c) a measured before/after token count on 5 fixtures is attached to the PR; (d) idle browser closes after the configured time and RSS per session is recorded.

## Measures (put both in the report)

- Non-test Go lines before and after: `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l`.
- Deadcode before and after: `GOTOOLCHAIN=go1.26.7 go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./... | wc -l`.
The repo is 20357 lines against an 8000-line budget. Prefer deleting to adding. Nothing you add may be unreachable from `cmd/factory`.

## Lessons from K3 and K4

- `deadcode` and `golangci-lint` need `GOTOOLCHAIN=go1.26.7`.
- `internal/conformance` pins exported names; if you rename one, fix the three lines there and list it.
- Wiring adds lines. Delete what your change makes redundant in the same commit.

## Setup

1. `git fetch origin && git checkout -b go/k5-browsercheck-lean origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

the browsercheck check pack only

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Twelve sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k5-browsercheck-lean`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k5-browsercheck-lean"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k5-browsercheck-lean
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
