You are one of about 50 agents working in parallel: 12 build slices of the factory on `next`, 8 in kaasbot, others research open source. Each build ticket below comes from a research session that read the upstream code at a pinned SHA. Your job is to copy or port the named upstream pieces (MIT or Apache-2.0 only; first line of a copied or ported file is `// Ported from <repo>@<sha> <path>`, plus a `THIRD_PARTY_NOTICES.md` section), not to redesign them. Stay inside your area.

Clone the upstream at the pinned SHA: `git clone https://github.com/<repo> /tmp/up && git -C /tmp/up checkout <sha>`. If the report left a licence question open (for example a dependency or grammar file), check it first and skip the piece if it is not MIT or Apache-2.0.

## Ticket: deterministic assertion kit with a weighted scorecard

Port promptfoo's MIT assertion semantics to Go; no model-graded assertions.

## Acceptance

The acceptance lines of your ticket drafts below, each with a test. Bite-check: revert each fix once and watch its test fail; say so in the report. Anything left out is listed with the reason.

### From research report `promptfoo` (your tickets: #1; the others belong to other sessions)

Copy list:

All upstream paths are under src/ at SHA 4f6710156d4a8426b852cf3af2b54c593a0e5177. Everything is TypeScript, so each row is a port to Go (MIT allows copying with the copyright and licence notice kept in the file header or a NOTICE).
| upstream path@sha | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| redteam/plugins/codingAgent/verifiers.ts@4f67101 | MIT | 3514 | adds deterministic grading to auditor coding-agent checks | Port the path, symlink, host, procfs, canary-variant logic to Go. Take trace input from our sandbox and session logs, not promptfoo provider raw output and OTel spans. Port selectively: start with secret-env-read, secret-file-read, sandbox-write-escape, network-egress-bypass. Skip the 3.5k file as one unit. |
| redteam/constants/codingAgents.ts@4f67101 | MIT | 81 | adds plugin ids, names, descriptions to the auditor pack manifest | Re-key as YAML or Go consts. |
| redteam/plugins/codingAgent/graders.ts@4f67101 | MIT | 214 | adds per-plugin fail and do-not-fail rubric text for the LLM fallback | Copy the rubric prose only (the "fail when / do not fail when" rules). Run it on our small triage model and only when the verifier is inconclusive. |
| redteam/util.ts@4f67101 lines 121-283 (isBasicRefusal and lists) | MIT | about 163 | replaces any ad hoc refusal check in internal/eval | Convert to Go regexp. Keep apostrophe normalisation. |
| assertions/refusal.ts@4f67101 | MIT | 61 | adds is-refusal with inverse semantics and empty-output handling | Port the logic, keep the three rules: provider flag wins, empty output counts as refusal, structured output is serialised before matching. |
| assertions/assertionsResult.ts@4f67101 | MIT | 456 | adds weighted score, named metrics, assert-set thresholds to eval scorecard | Port the aggregation only (weight, threshold, zero-weight measure-only). Drop the JS and Python script handling. |
| assertions/trajectory.ts, toolCallF1.ts, skill.ts@4f67101 | MIT | 668 + 433 + 205 | adds trace assertions to eval | Map to our own tool-call event schema. Skip the goal-success handler (LLM judged) at first. |
| redteam/riskScoring.ts@4f67101 | MIT | 390 | adds severity-weighted risk score to auditor report | Port formulas. Replace STRATEGY_METADATA with our strategy list. Decide our own impact table, do not take theirs unreviewed. |
| redteam/constants/metadata.ts severityRiskScores and default plugin severity map (about lines 488-520) | MIT | about 40 | adds default severities per plugin | Re-map to our plugin ids. |
| redteam/strategies/base64.ts, rot13.ts, hex.ts, leetspeak.ts, homoglyph.ts, promptInjections/data.ts@4f67101 | MIT | 11+19+14+35+90+108 = 277 | adds zero-token attack transforms to auditor | Trivial Go ports. Check each prompt string in data.ts for fit before use. |
| redteam/plugins/shellInjection.ts, ssrf.ts, dataExfil.ts, excessiveAgency.ts (DEFAULT_EXAMPLES blocks) | MIT | 136 + 223 + 186 + 138 = 683 | adds seed examples for generated attacks in auditor | Take the example prompts and grader guidance only. Generate attacks once, cache the fixtures, replay without a model. |

Ticket drafts:

1. area: internal/eval. Goal: deterministic assertion kit with weighted scorecard.
   - Add is-refusal (with inverse), contains, regex, json-valid, cost, latency assertions with promptfoo-compatible names.
   - Add weight, threshold, named-metric and assert-set aggregation ported from assertionsResult.ts@4f67101; weight 0 means measure only.
   - Add tool-used, tool-sequence, step-count assertions over our tool-call event log.
   - Header or NOTICE records upstream SHA and MIT licence. Unit tests include one failing case per assertion. No model call anywhere in this ticket.
2. area: auditor red-team pack. Goal: coding-agent verifiers v1.
   - Port secret-env-read, secret-file-read, sandbox-write-escape and network-egress-bypass verifiers to Go, input is our session trace and a canary config.
   - Each verifier ships a fixture that must fail and a fixture that must pass, including a base64 variant of the canary and a symlink escape.
   - LLM grader is called only when the verifier is inconclusive, using the "do not fail" rubric text from graders.ts. Report how many fixtures hit the LLM.
   - Run the pack against pkg/sandbox and record the result as a scorecard.
3. area: auditor red-team pack. Goal: severity scoring and zero-token strategies.
   - Port base64, rot13, hex, leetspeak, homoglyph transforms and riskScoring formulas.
   - Own impact table reviewed by a human before release; report shows score, level and worst strategy per plugin.
   - Generated attack prompts are cached by hash and replayed; a rerun with no config change makes zero model calls.

## Measures (put both in the report)

- Non-test Go lines before and after: `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l`.
- Deadcode before and after: `GOTOOLCHAIN=go1.26.7 go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./... | wc -l`.
The repo is 20357 lines against an 8000-line budget. Prefer deleting to adding. Nothing you add may be unreachable from `cmd/factory`.

## Lessons from K3 to K6

- `deadcode` and `golangci-lint` need `GOTOOLCHAIN=go1.26.7`.
- `internal/conformance` pins exported names; if you rename one, fix the three lines there and list it.
- Wiring adds lines. Delete what your change makes redundant in the same commit.

## Setup

1. `git fetch origin && git checkout -b go/k7-assert-kit origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

new `internal/eval/assert/` only

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Twelve sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k7-assert-kit`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k7-assert-kit"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k7-assert-kit
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
