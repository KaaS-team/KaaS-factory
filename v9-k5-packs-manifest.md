You are one of about 50 agents working in parallel: 12 build slices of the factory on `next`, 8 in kaasbot, others research open source. Each build ticket below comes from a research session that read the upstream code at a pinned SHA. Your job is to copy or port the named upstream pieces (MIT or Apache-2.0 only; first line of a copied or ported file is `// Ported from <repo>@<sha> <path>`, plus a `THIRD_PARTY_NOTICES.md` section), not to redesign them. Stay inside your area.

Clone the upstream at the pinned SHA: `git clone https://github.com/<repo> /tmp/up && git -C /tmp/up checkout <sha>`. If the report left a licence question open (for example a dependency or grammar file), check it first and skip the piece if it is not MIT or Apache-2.0.

## Ticket: pack manifest retry block, validation caps and path/keyword triggers

One manifest change set.

## Acceptance

The acceptance lines of your ticket drafts below, each with a test. Bite-check: revert each fix once and watch its test fail; say so in the report. Anything left out is listed with the reason.

### From research report `goose` (your tickets: #1, #2; the others belong to other sessions)

Copy list:

| upstream path@910d084 | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| crates/goose/src/agents/retry.rs (execute_success_checks_with_timeout, execute_shell_command, 8 KiB stderr cap) | Apache-2.0 | 233 | adds verified-success retry to factory graph and kaasbot run | Port Rust to Go (about 80 lines estimate); keep timeout defaults 300 s / 600 s |
| crates/goose/src/agents/types.rs RetryConfig + SuccessCheck + validate() | Apache-2.0 | about 50 (lines 11-62) | schema for pack retry block | Re-express as Go struct and YAML |
| crates/goose/src/recipe/validate_recipe.rs caps and parameter rules | Apache-2.0 | about 60 of 1,342 | pack manifest validation in packs module | Port the limits and select-option checks only |
| crates/goose/src/scheduler/full.rs lines 142-170 (cron normalise) and 417-500 (skip bad jobs at load) | Apache-2.0 | about 110 | serve scheduler load path | Go cron lib (robfig) already handles 5/6 fields; copy the behaviour, not the code |
| workflow_recipes/release_risk_check/* | Apache-2.0 | recipe.yaml, run.sh (11), report .py | template for a "script first, LLM second" pack | Replace goose-specific architecture text with ours |
| crates/goose/src/tool_monitor.rs | Apache-2.0 | 135 | loop guard in gate / run | Port to Go (about 60 lines estimate); compares name and arguments of repeated calls |

Ticket drafts:

1. area: packs. Goal: add optional `retry` block to pack manifest (max_retries, shell checks, on_failure, timeouts). Acceptance: a failing check re-runs the task up to max_retries; a passing check ends it; timeouts default 300 s and 600 s; stderr capped at 8 KiB; unit tests for pass, fail, timeout.
2. area: packs. Goal: manifest validation caps (32 params, 200 select options, 128 KiB params) and bounded read that fails if the file changed after validation. Acceptance: tests for each cap; lock hash mismatch fails the load.
3. area: serve + gate. Goal: scheduler job controls (pause, unpause, run_now, kill, update cron) with per-job run history, bad jobs skipped at load with a logged reason, and a tool-repeat guard (same name and args N times) in run. Acceptance: each control has a test; a corrupt job does not stop the daemon; the guard aborts a looping run and records why.

### From research report `openhands` (your tickets: #3; the others belong to other sessions)

Copy list:

| upstream path@sha | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| openhands-sdk/openhands/sdk/conversation/stuck_detector.py@10be259 | MIT | 539 | adds loop guard to dispatch/local (parse `claude -p --output-format stream-json` events) | Port to Go; map ActionEvent/ObservationEvent to stream-json tool_use/tool_result; keep thresholds 4/3/3/6 and window 20; drop pydantic state |
| openhands-sdk/openhands/sdk/conversation/secret_registry.py@10be259 (StreamOutputMask lines 117-160, mask_secrets_in_output 304-333) | MIT | ~120 of 441 | adds output masking to pkg/sandbox and gate | Port the chunk-boundary buffer; our secrets come from env/keychain, drop the SecretSource wrappers |
| openhands-sdk/openhands/sdk/skills/trigger.py + skill.py path_matches_glob/_compile_path_glob (67-95) and match_trigger (733-765)@10be259 | MIT | ~47 + ~60 | adds path/keyword triggers to packs | Port glob-to-regex for `**`; add `paths:` and `keywords:` frontmatter to our pack manifest |
| openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py@10be259 (policy only) | MIT | ~150 of 566 | adds summarize-the-middle to kaasbot memory/run | Port trigger logic (events or tokens), keep-first, system prompt pinned; summarizer = haiku-class model via triage path |
| openhands-sdk/openhands/sdk/hooks/types.py + config.py (HookMatcher)@10be259 | MIT | 40 + ~100 | extends gate with named lifecycle points | Port event names and matcher semantics; decisions feed CEL result |

Ticket drafts:

1. area: dispatch/local. Goal: loop guard ported from stuck_detector.py. Acceptance: Go package parses stream-json tool events; detects the 5 patterns with thresholds 4/3/3/6 over a 20-event window; emits one nudge then aborts the session on the next hit; fixture tests for each pattern; MIT notice in file header.
2. area: pkg/sandbox + gate. Goal: streaming secret masker. Acceptance: chunk-split secret is masked across a boundary in a fixture; secrets only injected when named in the command; no secret value in logs or ledger.
3. area: packs. Goal: `paths:` and `keywords:` triggers on pack skills. Acceptance: skill body injected only on match; eval scorecard shows token count per task before and after on 3 fixtures; no pass-rate drop.

## Measures (put both in the report)

- Non-test Go lines before and after: `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l`.
- Deadcode before and after: `GOTOOLCHAIN=go1.26.7 go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./... | wc -l`.
The repo is 20357 lines against an 8000-line budget. Prefer deleting to adding. Nothing you add may be unreachable from `cmd/factory`.

## Lessons from K3 and K4

- `deadcode` and `golangci-lint` need `GOTOOLCHAIN=go1.26.7`.
- `internal/conformance` pins exported names; if you rename one, fix the three lines there and list it.
- Wiring adds lines. Delete what your change makes redundant in the same commit.

## Setup

1. `git fetch origin && git checkout -b go/k5-packs-manifest origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/packs/` (not `repomap/`)

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Twelve sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k5-packs-manifest`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k5-packs-manifest"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k5-packs-manifest
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
