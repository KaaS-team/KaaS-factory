You fix three defects a merge reviewer found on `next` of KaaS-team/KaaS-factory (Go, branch `next`). Each fix is test-first: write the test, watch it fail on `next`, fix, watch it pass.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. `just --version`. If `just` is missing, run the `check` recipe body from `justfile` by hand and say so in the report.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## Defects

1. **Loop guard nudge never resets** (`internal/dispatch/local/stuck` and its caller in `internal/dispatch/local`). `g.nudged` is set by an action-error nudge and never cleared, so any later, unrelated loop pattern aborts at once instead of being nudged first. Reset it once the session makes progress (a different action after the nudge), so each separate stall gets its own nudge. Also: Steer is unsupported for local sessions, so the "nudge" is only a count; make the code and its doc comment say what it does (no claim of a delivered nudge).
2. **Abort replaces a clean exit.** An abort that lands just as the process exits normally turns a clean exit into `ErrStuck`. If the process exited 0 before the kill took effect, the result is the clean exit. Test it with a fake process whose exit and the abort race (use `-race -count=50`).
3. **Egress wildcard covers a public suffix** (`pkg/sandbox/egress`). The depth gate counts labels, so `*.co.uk` passes and allows every `.co.uk` host. Refuse a wildcard whose base is a public suffix using `golang.org/x/net/publicsuffix` (already in the module graph if `go list -m golang.org/x/net` shows it; otherwise vet it before adding). `NewSecrets(0, ...)` turning the gate off: make 0 mean the default depth, not "off"; test both.

## Steps

`git fetch -q origin && git checkout -q -B next origin/next`, one commit per defect, bite check each (revert the fix, quote the failing line, restore), `go test -race -count=3` on the touched packages, `go run ./tools/ratchet`, the full gate (see Setup), `git push origin HEAD:next` (retry rule: merge fresh `origin/next`, re-run build, vet and touched tests, push; up to 8 tries).

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m3-fixes-k5"
```

Your final message is that same report:

```
TICKET: m3-fixes-k5
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
