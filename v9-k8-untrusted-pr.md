You are one of about 50 agents working in parallel: 12 build slices of the factory on `next`, 8 in kaasbot, others research open source. Each build ticket below comes from a research session that read the upstream code at a pinned SHA. Your job is to copy or port the named upstream pieces (MIT or Apache-2.0 only; first line of a copied or ported file is `// Ported from <repo>@<sha> <path>`, plus a `THIRD_PARTY_NOTICES.md` section), not to redesign them. Stay inside your area.

Clone the upstream at the pinned SHA: `git clone https://github.com/<repo> /tmp/up && git -C /tmp/up checkout <sha>`. If the report left a licence question open (for example a dependency or grammar file), check it first and skip the piece if it is not MIT or Apache-2.0.

## Ticket: untrusted-PR mode and session guard



## Acceptance

The acceptance lines of your ticket drafts below, each with a test. Bite-check: revert each fix once and watch its test fail; say so in the report. Anything left out is listed with the reason.

### From research report `claude-code-action` (your tickets: #3; the others belong to other sessions)

Copy list:

All MIT, so copying is allowed, but every file is TypeScript and we are Go: these are ports, not drop-ins. Keep the MIT notice and the copyright line (Anthropic, PBC, 2025) in ported files.
| upstream path@8a29bc6 | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| src/github/utils/sanitizer.ts | MIT | 162 | adds sanitise step to tracker/github before any issue/comment text reaches a prompt | Port regexes to Go regexp (RE2: no lookbehind, so the AWS and ANSI boundary rules need rewriting) |
| src/github/validation/trigger.ts | MIT | 203 | adds actor-equals-author and label/assignee trigger rules to tracker/github chatops | Map to our event structs; keep as table-driven tests |
| src/github/validation/untrusted-pr.ts | MIT | 221 | adds deny list for untrusted PR authors in gate (CEL) and pkg/sandbox | Express as CEL policy data; deny beats allow |
| src/github/operations/session-guard.ts | MIT | 234 | adds config snapshot/restore around a session in dispatch/local | Reimplement in Go with os.Lstat and git config --show-origin; same symlink and FIFO handling |
| src/github/operations/restore-config.ts | MIT | 349 | adds restore of SENSITIVE_PATHS from base branch | Reuse path list; drop Actions-specific parts |
| src/github/utils/actor-filter.ts | MIT | 90 | adds bot-name normalisation to tracker/github | Trivial port |
| src/github/validation/actor.ts + permissions.ts | MIT | 96 + 232 | adds human-actor and write-permission checks | Use our GitHub client; REST collaborator permission call |
| src/github/operations/fetch-depth.ts | MIT | 40 | adds shallow-safe fetch to gitx | Port: only pass --depth when repo is shallow |
| src/mcp/inline-comment-buffer.ts | MIT | 54 | adds buffer and de-dup to tracker/github review posting | Port to Go; JSONL file or in-memory |

Ticket drafts:

1. Area: tracker/github. Goal: sanitise all issue, comment and review text before prompt assembly. Acceptance: port of the eight sanitizer steps and token redaction; table tests for each of hidden comment, zero-width, bidi, alt text, link title, data-attr, numeric entity, five token formats; applied at the single prompt-building entry point; MIT notice kept.
2. Area: tracker/github chatops + gate. Goal: trigger and actor validation. Acceptance: comment author must equal actor; deleted/edited-by-other ignored; label/assignee triggers must match config; bot logins normalised with "[bot]"; human-actor and write-permission check with an allow-list for bots; all as table tests.
3. Area: dispatch + pkg/sandbox. Goal: untrusted-PR mode and session guard. Acceptance: PRs from authors without write access run with a deny list for code-executing commands that overrides allows; git config and SENSITIVE_PATHS are snapshotted before and restored after the session; a test plants a modified `.claude/settings.json` in a PR and shows it is reverted.

## Measures (put both in the report)

- Non-test Go lines before and after: `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l`.
- Deadcode before and after: `GOTOOLCHAIN=go1.26.7 go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./... | wc -l`.
The repo is 20357 lines against an 8000-line budget. Prefer deleting to adding. Nothing you add may be unreachable from `cmd/factory`.

## Lessons from K3 to K7

- `deadcode` and `golangci-lint` need `GOTOOLCHAIN=go1.26.7`.
- `internal/conformance` pins exported names; if you rename one, fix the three lines there and list it.
- Wiring adds lines. Delete what your change makes redundant in the same commit.

## Setup

1. `git fetch origin && git checkout -b go/k8-untrusted-pr origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

new `internal/dispatch/untrusted/` plus the smallest hook in the dispatch path

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Twelve sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k8-untrusted-pr`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k8-untrusted-pr"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k8-untrusted-pr
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
