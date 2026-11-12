You wire merged session packages of KaaS-team/KaaS-factory (Go, branch `next`) into the binary, so they run for real instead of only in their own tests. The ratchet's `reason` in `.ratchet.json` says it: "session packages not yet wired into cmd/factory". Your share: **the deadcode entries whose package path starts with `internal/p` to `internal/z`, `pkg/` and `tools/`**. Three sessions split the list by path, so stay inside yours.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. `just --version`. If `just` is missing, run the `check` recipe body from `justfile` by hand and say so in the report.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## Steps

1. `git fetch -q origin && git checkout -q -B next origin/next`.
2. `go run ./tools/ratchet` and the deadcode list itself: `GOOS=linux GOARCH=amd64 go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./... | sort`. Keep only your share. Group it by package.
3. For each package, decide from its doc comment, its tests and `AGENTS.md`'s boundaries where it belongs: a `factory` subcommand, `factory serve`'s loop, a dispatcher or tracker adapter, or a check pack. The core reaches the world only through `internal/api` ports, and the CLI/TUI/MCP reach the core only through `Control` and `Event`: wire through those, never around them.
4. Wire it with the smallest change in `cmd/factory` (or the composition root it already uses), plus a test that drives the real command or serve path and fails without the wiring. Bite check: remove the wiring line, watch the test fail, quote the line, restore.
5. A symbol with no caller by design (an alternative implementation nothing selects, a helper left from a refactor): delete it with its test. Never delete a port implementation another session is wiring; if unsure, leave it and list it.
6. `go run ./tools/ratchet --update` lowers `.ratchet.json`; commit it. `go test -race -count=3` on touched packages, then `just check`, then `git push origin HEAD:next` (retry rule).

Commit trailers: end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Quality bar (a reviewer reads your report against this)

- Read the whole diff before merging; you are the last reviewer before `next`.
- Every behaviour you add or fix gets a test that fails without it. Prove it: revert the fix line, run the test, watch it fail, restore. Quote the failing line in the report under "Bite checks".
- Run `go test -race -count=3` on every package you touched, so a flake shows up here and not in the next session.
- A branch whose content is already on `next` (an earlier squash merge): `git merge` it anyway when it is clean so the branch becomes an ancestor; when it conflicts only because `next` already has the same change, take `next`'s side and record it under "Already on next".
- Never widen scope: no refactor, rename or doc rewrite the branch did not ask for. List what you left out.

## Rules

- Never `SKIP_GATE`, never force-push, never `--no-verify`. Never edit the TS tree (`src/`, `tests/`, `dashboard/`, `scripts/`) or `.github/`.
- No `ANTHROPIC_*` or other provider key anywhere. No model name, token count or cost in a commit or file.
- No session URL, `claude.ai` link or `Claude-Session:` trailer in any commit or file.
- Do not open PRs, comment on issues or delete branches.
- Several wiring sessions push to `next` at the same time. A rejected push is normal: `git fetch -q origin`, `git rebase origin/next` (or redo the merge on a fresh `origin/next`), re-run `just check`, push again. Up to 6 tries per branch.
- `.ratchet.json` conflicts: take the larger `go_lines` and the larger `deadcode`, keep one reason line, then re-run `go run ./tools/ratchet` and raise again if needed.
- `THIRD_PARTY_NOTICES.md` and `NOTICE` conflicts: keep both sides' sections. `go.mod`/`go.sum`: keep both sides' requires, then `go mod tidy`.

## When you finish

Write the report to /tmp/report.md, then push it to its own branch (a repo hook refuses writes under `.factory/`):

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m3-wire-c"
```

Your final message is that same report:

```
TICKET: m3-wire-c
NEXT: <origin/next sha after your last push>
## Wired
- <package> -> <command or serve path that now reaches it, test name>
## Deleted
- <symbol> -> <why it has no caller by design>
## Left unwired
- <package> -> <why>
## Bite checks
- <test> -> <the line that failed when the wiring was reverted>
## Ratchet
<deadcode before -> after, go_lines before -> after>
## Gate evidence
<last lines of the last `just check`, verbatim>
## Learnings
<what cost time, one line each>
```
