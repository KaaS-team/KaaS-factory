You are one of about 50 agents working in parallel: 12 build slices of the factory on `next`, 8 in kaasbot, others research open source. Each build ticket below comes from a research session that read the upstream code at a pinned SHA. Your job is to copy or port the named upstream pieces (MIT or Apache-2.0 only; first line of a copied or ported file is `// Ported from <repo>@<sha> <path>`, plus a `THIRD_PARTY_NOTICES.md` section), not to redesign them. Stay inside your area.

Clone the upstream at the pinned SHA: `git clone https://github.com/<repo> /tmp/up && git -C /tmp/up checkout <sha>`. If the report left a licence question open (for example a dependency or grammar file), check it first and skip the piece if it is not MIT or Apache-2.0.

## Ticket: deny-overrides combiner that reports the determining policies

 Some of this may already exist on the base branch (earlier waves built nearby pieces): read the area first, keep what exists, build only the gap against the acceptance lines, and list in the report what you found already there.

## Acceptance

The acceptance lines of your ticket drafts below, each with a test. Bite-check: revert each fix once and watch its test fail; say so in the report. Anything left out is listed with the reason.

### From research report `policy` (your tickets: #2; the others belong to other sessions)

Copy list:

| upstream path@sha | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| open-policy-agent/opa v1/plugins/logs/mask.go@80f2755 | Apache-2.0 | 432 | adds redaction for kaasbot gate audit log and ee audit export | Drop EventV1 coupling; run on our decision struct or a map. Replace internal/deepcopy (29 lines, also copyable) |
| open-policy-agent/opa v1/internal/deepcopy/deepcopy.go@80f2755 | Apache-2.0 | 29 | support for mask.go | none |
| open-policy-agent/opa v1/bundle/sign.go + verify.go + v1/keys/keys.go@80f2755 | Apache-2.0 | 517 | adds signed policy packs for ee policy check (and factory packs lock) | Strip rego/ast and bundle manifest types; keep the JWT signing of file hashes. Estimate: 150 to 250 lines remain after trimming |
| open-policy-agent/opa v1/plugins/logs/sizeBuffer.go + buffer.go@80f2755 | Apache-2.0 | not measured | adds bounded in-memory buffer with drop counters for decision log shipping | Read before copying; check coupling to the plugin manager |
| open-policy-agent/opa v1/topdown/cancel.go@80f2755 | Apache-2.0 | 33 | adds cancel flag pattern | trivial; we can also use context.Context |
| open-policy-agent/opa v1/internal/ucast (partial eval to SQL-like conditions)@80f2755 | Apache-2.0 | 594 | possible: turn gate rules into filters for mailbox or tracker queries | Low priority; depends on Rego, so likely idea only |

No copy from Cedar (Rust) or cel-go (alias layer only).

Ticket drafts:

1. Area: kaasbot gate. Goal: decision record plus mask rules. Acceptance: every gate decision writes id, trace id, policy-set revision, input, result, requester, timestamp; config-defined JSON-pointer mask rules remove or replace fields and list them under `erased`; vendored mask.go keeps Apache-2.0 header and NOTICE; ported mask tests pass.
2. Area: ee policy check. Goal: deny-overrides combiner with determining policies. Acceptance: any matching forbid rule denies; no match denies; a rule that errors counts as non-match and is reported; response lists rule ids that decided; table tests cover permit, forbid, error, empty set.
3. Area: ee policy check and factory packs. Goal: signed policy sets plus load-time validation. Acceptance: policy files load only when signature verifies against a configured key; bad or missing signature fails closed with a clear error; every CEL rule type-checks against a declared env and has a cost limit at load; load fails listing all bad rules.

## Measures (put both in the report)

- Non-test Go lines before and after: `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l`.
- Deadcode before and after: `GOTOOLCHAIN=go1.26.7 go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./... | wc -l`.
The repo is 20357 lines against an 8000-line budget. Prefer deleting to adding. Nothing you add may be unreachable from `cmd/factory`.

## Lessons from K3 to K7

- `deadcode` and `golangci-lint` need `GOTOOLCHAIN=go1.26.7`.
- `internal/conformance` pins exported names; if you rename one, fix the three lines there and list it.
- Wiring adds lines. Delete what your change makes redundant in the same commit.

## Setup

1. `git fetch origin && git checkout -b go/k8-policy-combiner origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`ee/policy/` new file `combiner.go` and its test only

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Twelve sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k8-policy-combiner`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k8-policy-combiner"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k8-policy-combiner
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
