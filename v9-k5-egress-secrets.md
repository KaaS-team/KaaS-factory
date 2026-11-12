You are one of about 50 agents working in parallel: 12 build slices of the factory on `next`, 8 in kaasbot, others research open source. Each build ticket below comes from a research session that read the upstream code at a pinned SHA. Your job is to copy or port the named upstream pieces (MIT or Apache-2.0 only; first line of a copied or ported file is `// Ported from <repo>@<sha> <path>`, plus a `THIRD_PARTY_NOTICES.md` section), not to redesign them. Stay inside your area.

Clone the upstream at the pinned SHA: `git clone https://github.com/<repo> /tmp/up && git -C /tmp/up checkout <sha>`. If the report left a licence question open (for example a dependency or grammar file), check it first and skip the piece if it is not MIT or Apache-2.0.

## Ticket: egress allow/deny proxy with secret placeholders and a streaming masker

One small Go proxy (net/http, no new deps unless the ticket names one). The agent env carries placeholders only.

## Acceptance

The acceptance lines of your ticket drafts below, each with a test. Bite-check: revert each fix once and watch its test fail; say so in the report. Anything left out is listed with the reason.

### From research report `e2b` (your tickets: #2; the others belong to other sessions)

Copy list:

| upstream path@sha | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| spec/envd/process/process.proto@3e72be3 | Apache-2.0 | 171 | adds a guest process RPC contract to pkg/sandbox (start, reattach, signal, stdin) | keep file header and NOTICE; generate Go with buf; drop pty fields if unused |
| spec/envd/filesystem/filesystem.proto@3e72be3 | Apache-2.0 | 155 | adds file ops and watch to pkg/sandbox | same; trim to Stat/ListDir/Move/Remove/WatchDir |
| spec/envd/envd.yaml@3e72be3 (only /freeze, /fsfreeze, /fsthaw, /collapse, /init, /health) | Apache-2.0 | about 250 of 731 | adds a pre-pause quiesce handshake to our guest agent | we must write the Go handler ourselves; only the contract and the cgroup.freeze polling semantics are copied |
| spec/openapi.yml@3e72be3 (schemas SandboxOnTimeout, SandboxLifecycle, SandboxPauseMode, EnvdUnresponsiveAtPause, SandboxNetworkConfig, SandboxForkRequest/Result) | Apache-2.0 | about 300 of 9530 | gives pkg/sandbox config and status types | rewrite as Go structs; drop team, cluster, admin paths |
| packages/js-sdk/src/template/readycmd.ts@3e72be3 | Apache-2.0 | 127 | ready-check strings for template start (port, URL, file, timeout) | port to Go; keep shellQuote semantics |
| packages/js-sdk/src/sandbox/iam.ts@3e72be3 (validateIamTokenName logic only) | Apache-2.0 | about 30 of 149 | token-name validation for a placeholder-secret scheme | port the regex and rationale; skip the JS Proxy trickery |

Ticket drafts:

1. Area: pkg/sandbox. Goal: lifecycle contract. Acceptance: Go types for onTimeout (kill|pause), pauseMode (filesystem only for now), autoResume; pause persists workdir, resume cold-starts and reports pauseMode; a failed resume returns a typed error with a retry-without-state path; unit test per transition.
2. Area: pkg/sandbox + gate. Goal: egress allow/deny with placeholder secrets. Acceptance: network config with allowOut/denyOut (allow wins, domain and wildcard), dnsServers; secret placeholders resolved by a local proxy only for listed domains; gate rejects wildcard transforms broader than a configured depth; token name validator ported from iam.ts with its test cases; Apache-2.0 notice added.
3. Area: kaasbot always-on host. Goal: guest RPC from E2B protos. Acceptance: process.proto and filesystem.proto vendored with licence header, Go stubs generated, a minimal server for Start/Connect/SendSignal/Stat/ListDir, and a wake test that reattaches to a running process after a host restart.

### From research report `microsandbox` (your tickets: #3; the others belong to other sessions)

Copy list:

| upstream path@sha | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| crates/runtime/lib/runner/policy.rs@28bdced | Apache-2.0 | 40 (about 15 non-test) | adds max_duration/idle/ephemeral policy shape to pkg/sandbox config | port struct to Go; keep Apache NOTICE if text copied |
| crates/agentd/lib/rlimit.rs@28bdced | Apache-2.0 | 95 | adds baseline + per-exec rlimit model to pkg/sandbox | rewrite in Go with syscall.Setrlimit; keep name whitelist and fail-on-unknown rule |
| crates/runtime/lib/runner/heartbeat.rs@28bdced (logic only) | Apache-2.0 | 379 (about 200 logic) | adds idle reclaim decision table | our jail has no virtiofs; replace heartbeat file with last-activity timestamp from our own exec supervisor |
| crates/network/lib/model/policy/types.rs@28bdced (schema only) | Apache-2.0 | 2,880 | adds egress rule schema to pkg/sandbox | take field model, not code; much smaller subset is enough |
| docs/security/*.mdx@28bdced | Apache-2.0 | n/a | threat-model wording for our enterprise docs | edit to our design |

Copying is permitted by licence but the code is Rust, so every row is a port, not a paste.

Ticket drafts:

1. Area: pkg/sandbox. Goal: add Policy{MaxDuration, IdleTimeout, Ephemeral}. Acceptance: session killed at max duration; idle session reclaimed after timeout; detached children do not block idle; no timeout set means never reclaimed; table tests for all four.
2. Area: pkg/sandbox. Goal: two-layer rlimits (baseline for init, per-exec override). Acceptance: whitelist of resource names; unknown name fails at session start with a clear error; child inherits baseline; test proves RLIMIT_NPROC and RLIMIT_AS enforced.
3. Area: pkg/sandbox + kaasbot gate. Goal: spike secret placeholders via a local egress proxy. Acceptance: agent env has only placeholders; real value substituted only for allowed hosts over TLS; leak test with a hostile host fails closed; written design with go/no-go on a VM backend.

### From research report `openhands` (your tickets: #2; the others belong to other sessions)

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

1. `git fetch origin && git checkout -b go/k5-egress-secrets origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

new `pkg/sandbox/egress/`

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Twelve sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k5-egress-secrets`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k5-egress-secrets"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k5-egress-secrets
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
