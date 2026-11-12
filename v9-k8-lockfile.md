You are one of about 50 agents working in parallel: 12 build slices of the factory on `next`, 8 in kaasbot, others research open source. Each build ticket below comes from a research session that read the upstream code at a pinned SHA. Your job is to copy or port the named upstream pieces (MIT or Apache-2.0 only; first line of a copied or ported file is `// Ported from <repo>@<sha> <path>`, plus a `THIRD_PARTY_NOTICES.md` section), not to redesign them. Stay inside your area.

Clone the upstream at the pinned SHA: `git clone https://github.com/<repo> /tmp/up && git -C /tmp/up checkout <sha>`. If the report left a licence question open (for example a dependency or grammar file), check it first and skip the piece if it is not MIT or Apache-2.0.

## Ticket: versioned sorted lockfile and pattern-matched path rules

Adapt dagger util/lockfile (Apache-2.0); moby/patternmatcher is Apache-2.0 and may be added as a dependency. Keep reading today's `factory.lock` format.

## Acceptance

The acceptance lines of your ticket drafts below, each with a test. Bite-check: revert each fix once and watch its test fail; say so in the report. Anything left out is listed with the reason.

### From research report `dagger` (your tickets: #3; the others belong to other sessions)

Copy list:

| upstream path@sha | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| engine/cachevolumedir/store.go@835b0ef | Apache-2.0 | 942 | adds warm cache store to pkg/sandbox | Only imports x/sys/unix and stdlib. Linux-only (flock, unix). Rename package, drop Dagger naming, wire Policy to our host budget. |
| core/llm_recording.go@835b0ef (RecordedResponseProvider, decodeRecordedMessages, media diff) | Apache-2.0 | 240 | adds replay provider to eval | Depends on dagql.Bytes, LLMMessage types and go-cmp. Re-implement against our message type; copy the algorithm and diff shape. |
| util/scrub/scrub.go@835b0ef | Apache-2.0 | 262 | adds output stabiliser to eval and gate tests | Imports dagql/idtui and midterm for terminal handling. Keep only the regex table and `Stabilize`; replace Dagger-specific rules with ours. |
| util/lockfile/lockfile.go@835b0ef | Apache-2.0 | 437 | replaces our packs lock / gate pin file code | Stdlib only. Change namespaces and header text. |
| util/patternmatcher/patternmatcher.go@835b0ef | MIT-origin fork (moby), Apache-2.0 repo | 548 | replaces glob matching in gate and sandbox mounts | Or import github.com/moby/patternmatcher directly (Apache-2.0) and skip the copy. Prefer the direct import. |
| util/parallel/parallel.go@835b0ef | Apache-2.0 | 213 | optional eval runner fan-out | Imports OTel tracing; strip tracing or map to our meter. Low value, errgroup may suffice. |

Ticket drafts:

1. Area: pkg/sandbox. Goal: add a crash-safe cache volume store adapted from dagger engine/cachevolumedir (Apache-2.0, SHA 835b0ef). Acceptance: volumes keyed by digest including tenant; flock single owner; Collect honours max-used and min-free policy with LRU and never removes pinned volumes; kill -9 test leaves a consistent directory; NOTICE and licence retained.
2. Area: eval. Goal: replay provider plus output scrubber so fixtures run with no model calls. Acceptance: a recorded fixture replays with 0 provider calls; divergence error names the first differing message index with a diff that never prints media bytes; scrub rules cover digests, sizes, timings and ports; CI runs replay by default and live only on re-record.
3. Area: packs and gate. Goal: replace our lock and pin file code with a lockfile adapted from dagger util/lockfile, and use moby/patternmatcher for path rules. Acceptance: sorted, versioned file with merge-conflict detection and a header telling agents to commit it; gate path allow/deny tests pass with Dockerignore-style globs including negation.

## Measures (put both in the report)

- Non-test Go lines before and after: `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l`.
- Deadcode before and after: `GOTOOLCHAIN=go1.26.7 go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./... | wc -l`.
The repo is 20357 lines against an 8000-line budget. Prefer deleting to adding. Nothing you add may be unreachable from `cmd/factory`.

## Lessons from K3 to K7

- `deadcode` and `golangci-lint` need `GOTOOLCHAIN=go1.26.7`.
- `internal/conformance` pins exported names; if you rename one, fix the three lines there and list it.
- Wiring adds lines. Delete what your change makes redundant in the same commit.

## Setup

1. `git fetch origin && git checkout -b go/k8-lockfile origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/packs/` lock read and write files only (not `astgrep/`, `checkmd/`, `depup/`, `repomap/`)

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Twelve sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k8-lockfile`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k8-lockfile"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k8-lockfile
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
