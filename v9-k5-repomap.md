You are one of about 50 agents working in parallel: 12 build slices of the factory on `next`, 8 in kaasbot, others research open source. Each build ticket below comes from a research session that read the upstream code at a pinned SHA. Your job is to copy or port the named upstream pieces (MIT or Apache-2.0 only; first line of a copied or ported file is `// Ported from <repo>@<sha> <path>`, plus a `THIRD_PARTY_NOTICES.md` section), not to redesign them. Stay inside your area.

Clone the upstream at the pinned SHA: `git clone https://github.com/<repo> /tmp/up && git -C /tmp/up checkout <sha>`. If the report left a licence question open (for example a dependency or grammar file), check it first and skip the piece if it is not MIT or Apache-2.0.

## Ticket: ranked, token-budgeted repo map for context packs

Port aider's ranking and budget search to Go. If go-tree-sitter needs CGO, use a pure-Go parser for Go files (go/parser) and regex tag queries for ts/py, and say so; the binary stays CGO_ENABLED=0.

## Acceptance

The acceptance lines of your ticket drafts below, each with a test. Bite-check: revert each fix once and watch its test fail; say so in the report. Anything left out is listed with the reason.

### From research report `aider` (your tickets: #1; the others belong to other sessions)

Copy list:

| upstream path@5dc9490 | licence | lines | replaces or adds in ours | adaptation needed |
|---|---|---|---|---|
| aider/queries/tree-sitter-language-pack/*-tags.scm (32 files; go-tags.scm is 42 lines, rust 60, javascript 88) | Apache-2.0 for aider's copy; each file derives from an upstream grammar repo with its own licence (listed in queries/*/README.md, mostly MIT, some Apache-2.0) | about 1,700 est (not summed) | adds to factory packs: language-aware def/ref tags for the repo map | Keep only the languages we use (go, ts/js, python, rust at first). Verify each file's origin licence is MIT or Apache-2.0 and carry the attribution. Run with go-tree-sitter (MIT) |
| aider/repomap.py lines 365-575 (ranking) and 629-708 (budget search) | Apache-2.0 | about 280 | adds a `packs/repomap` Go package | Rewrite in Go as a port: PageRank is about 30 lines of power iteration, no networkx needed. Replace token_count with our meter estimator. Keep the weight constants as the starting point |
| aider/coders/editblock_coder.py lines 127-336 and 602-630 (matching cascade, similar-lines hint) | Apache-2.0 | about 260 | adds a tolerant search/replace applier to factory dispatch/gitx and kaasbot run | Port to Go; uses difflib SequenceMatcher, use a Go Levenshtein or ratio lib. Drop dmp dependency |
| aider/coders/editblock_prompts.py (172) | Apache-2.0 | 172 | prompt text for a SEARCH/REPLACE preset | Trim to our preset; check it against our no-API-key `claude -p` flow, where the native Edit tool already exists (see Ideas) |
| benchmark/benchmark.py summarize_results/load_results shape (lines 447-600) | Apache-2.0 | about 150 | eval matrix scorecard schema: pass_rate_N, cost, malformed count, per-language split, `--diffs` | Schema and aggregation only; our fixtures replace the exercism harness |

Ticket drafts:

1. **area: packs.** Goal: Go `repomap` package that emits a ranked, token-budgeted symbol map for a context pack. Acceptance: (a) go-tree-sitter parse of go, ts, py with .scm queries carrying attribution; (b) personalised PageRank with the repomap.py weights, seeds from ticket-mentioned files and idents; (c) output fits a configured token budget via binary search; (d) mtime-keyed tag cache; (e) parse runs in sandbox with size/time caps.
2. **area: eval.** Goal: add edit-format and try-N axes to the eval matrix scorecard. Acceptance: (a) result JSON has pass_rate_1..N, cost, malformed_count per cell; (b) `eval diff runA runB`; (c) `--replay` re-scores stored model output without a model call; (d) cell dimensions: model x format x fixture.
3. **area: kaasbot run.** Goal: tolerant SEARCH/REPLACE applier in Go for direct small-model edits. Acceptance: (a) exact, whitespace-insensitive, elision and edit-distance fallbacks ported from editblock_coder.py with attribution; (b) failure returns nearest-lines hint; (c) eval shows apply-success rate before vs after on 20 fixtures.

## Measures (put both in the report)

- Non-test Go lines before and after: `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l`.
- Deadcode before and after: `GOTOOLCHAIN=go1.26.7 go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./... | wc -l`.
The repo is 20357 lines against an 8000-line budget. Prefer deleting to adding. Nothing you add may be unreachable from `cmd/factory`.

## Lessons from K3 and K4

- `deadcode` and `golangci-lint` need `GOTOOLCHAIN=go1.26.7`.
- `internal/conformance` pins exported names; if you rename one, fix the three lines there and list it.
- Wiring adds lines. Delete what your change makes redundant in the same commit.

## Setup

1. `git fetch origin && git checkout -b go/k5-repomap origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

new `internal/packs/repomap/`

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Twelve sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k5-repomap`. Run `just fast` before every push and `just check` before the last one.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k5-repomap"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k5-repomap
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
