You fix the blockers that stopped seven reviewed session branches from merging into `next` of KaaS-team/KaaS-factory (Go, branch `next`), then merge them, ten branches in all.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. `just --version`. If `just` is missing, run the `check` recipe body from `justfile` by hand and say so in the report.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## Blockers

1. **Merge these three fixed branches first, in this order** (a local session prepared them; each merges cleanly into next and only the ratchet ceilings need raising):
   - `go/k4-sandbox-harden-fix`: macOS sandbox fix, plus the dispatcher fix that stops `TestStuckRunIsNudgedThenAborted` hanging (the read loop stops at the abort). Confirm with `go test -race -count=20 ./internal/dispatch/local`.
   - `go/k5-eval-arms-fix`: eval arms, plus the `TestSlowSubscriberDroppedLoopKeepsTicking` flake fix.
   - `go/fix-egress-ssrf`: AllowOut can no longer reach loopback, private or metadata addresses.
2. `go/k5-local-auth`, `go/k5-preset-rules`, `go/k5-sandbox-runsc`: failed only on that test. Merge each after the three above.
3. `go/k5-sandbox-lifecycle`: `go vet` fails, `pkg/sandbox/limits_test.go:51:18: undefined: run` (a helper another branch renamed or removed). Fix it in the merge.
4. `go/k5-sandbox-limits`: conflicts in `internal/dispatch/local/local.go` with what is on `next` now. Resolve by keeping both intents.
5. `go/k6-approval`: the gate fails after merging. Find out why and fix it in the merge.

## For each branch

Same merge procedure: `git fetch -q origin && git checkout -q -B next origin/next`, `git merge --no-ff --no-edit origin/go/<branch>`, review its diff for security holes and tests that cannot fail, `go mod tidy`, `go run ./tools/ratchet` and raise `.ratchet.json` to the measured values with the reason "raised by the reviewed merge of go/<branch> (session packages not yet wired into cmd/factory); lowered by go run ./tools/ratchet --update, a raise needs a hand edit and a new reason here" when needed, `just check`, `git push origin HEAD:next`.

Commit trailers: end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rules

- Never `SKIP_GATE`, never force-push, never `--no-verify`. Never edit the TS tree (`src/`, `tests/`, `dashboard/`, `scripts/`) or `.github/`.
- No `ANTHROPIC_*` or other provider key anywhere. No model name, token count or cost in a commit or file.
- No session URL, `claude.ai` link or `Claude-Session:` trailer in any commit or file.
- Do not open PRs, comment on issues or delete branches.
- Several merge sessions push to `next` at the same time. A rejected push is normal: `git fetch -q origin`, `git rebase origin/next` (or redo the merge on a fresh `origin/next`), re-run `just check`, push again. Up to 6 tries per branch.
- `.ratchet.json` conflicts: take the larger `go_lines` and the larger `deadcode`, keep one reason line, then re-run `go run ./tools/ratchet` and raise again if needed.
- `THIRD_PARTY_NOTICES.md` and `NOTICE` conflicts: keep both sides' sections. `go.mod`/`go.sum`: keep both sides' requires, then `go mod tidy`.

## When you finish

Write the report to /tmp/report.md, then push it to its own branch (a repo hook refuses writes under `.factory/`):

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m1-fix"
```

Your final message is that same report:

```
TICKET: m1-fix
NEXT: <origin/next sha after your last push>
## Merged
- <branch> -> <merge commit sha>
## Skipped
- <branch> -> <why, with the failing test or conflict>
## Review notes
- <branch>: <bug or risk you saw in its diff, or "clean">
## Gate evidence
<last lines of the last `just check`, verbatim>
## Learnings
<what cost time, one line each>
```
