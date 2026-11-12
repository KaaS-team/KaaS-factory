You make the gate of KaaS-team/KaaS-factory (Go, branch `next`) run the same everywhere. Cloud sessions report two problems: `just` is missing, and the `golangci-lint` on PATH is v2.5.0 built with Go 1.25, which cannot load this `go 1.26.0` module, yet the `justfile` prefers the PATH binary over the pinned v2.13.2.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. `just --version`. If `just` is missing, run the `check` recipe body from `justfile` by hand and say so in the report.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## Steps

1. `git fetch -q origin && git checkout -q -B next origin/next`. Read `justfile`, `.agents/repo.json` and `.github/workflows/go.yml` (read only; do not edit `.github/`).
2. Make the lint step use the PATH binary only when `golangci-lint version` reports exactly the pinned version; otherwise `go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2` with `GOTOOLCHAIN=go1.26.7`. One place holds the version (a `justfile` variable); a test or check asserts the `justfile` pin equals the one in `.github/workflows/go.yml`, wired into `just check` (Rule 0).
3. Add `scripts`-free fallback: a `tools/gate` Go command (or a POSIX `gate.sh` at the repo root, whichever is smaller) that runs exactly the `check` recipe's steps for hosts without `just`, and a test that the two lists of steps match, so they cannot drift. `AGENTS.md` Commands gets one line for it.
4. Prove it: run the fallback with the old PATH lint present, show lint uses the pinned version; change the pin in one place only and show the drift check fails.
5. `just check` (or the fallback), `git push origin HEAD:next` (retry rule).

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m3-gate-tooling"
```

Your final message is that same report:

```
TICKET: m3-gate-tooling
NEXT: <origin/next sha after your last push>
## Fixed
- <defect> -> <commit sha, test name>
## Bite checks
- <test> -> <the line that failed when the fix was reverted>
## Not fixed
- <defect> -> <why>
## Gate evidence
<last lines of the last `just check`, verbatim>
## Learnings
<what cost time, one line each>
```
