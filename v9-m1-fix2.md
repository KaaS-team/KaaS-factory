You finish the ten fix branches the m1-fix session could not land on `next` of KaaS-team/KaaS-factory (Go). Its gate passed every time; it lost the push race against other merge sessions. Those have now finished, so pushes should land.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. `just --version`. If `just` is missing, run the `check` recipe body from `justfile` by hand and say so in the report.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## Order and known fixes (from the previous attempt)

1. `go/k4-sandbox-harden-fix` (passed the full gate before; `go test -race -count=20 ./internal/dispatch/local` passed).
   Then fix two review findings in follow-up commits, each test-first:
   - `sessionConfigDir` copies the operator's `.credentials.json` into a new temp dir per session and never removes it, also on the error path. Remove it when the session ends and on every error path; make the dir mode 0700 and not writable from other jails. Test: after a run (and after a failed start) the dir is gone.
   - Under GitDir the jail can write all of `refs/`, so an agent can move any branch. Limit writes to the session's own `refs/heads/factory/<ticket>-*` (and its lease ref) if the sandbox can express it; if not, write it under "Not fixed" with the exact sandbox profile line.
2. `go/k5-eval-arms-fix`, then `go/fix-egress-ssrf` (both merge cleanly on top of 1).
3. `go/k5-local-auth`, `go/k5-preset-rules`, `go/k5-sandbox-runsc`.
4. `go/k5-sandbox-lifecycle` (merges cleanly; the `undefined: run` vet error did not reproduce).
5. `go/k5-sandbox-limits`: conflicts in `internal/dispatch/local/local.go`; keep `next`'s stuck guard (`p.err = stuckErr`) and call `sandbox.KillGroup(cmd)`; also resolves in `pkg/sandbox/{plan,sandbox,unix}.go` keeping both intents.
6. `go/k6-approval`: gate fails with `internal/tracker/github/approval.go:12: undefined: Latest, ParseData`; the codec moved to `internal/marker`, so call `marker.Latest(marker.ParseData(c.Body), stagePlan)`.

## Push race

Merge all ten locally on one branch first, run the full gate once, then push. On a rejection: `git fetch`, rebase (or redo the merges on fresh `origin/next`), run `go build ./... && go vet ./...` plus `go test -race` on the packages either side touched, then push; run the full gate once more after the final push and fix forward if red. Up to 10 tries.

## Merge procedure per branch

`git merge --no-ff --no-edit origin/go/<branch>`, review the diff (security holes, tests that cannot fail), `go mod tidy`, ratchet raise with the standard reason when needed.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m1-fix2"
```

Your final message is that same report:

```
TICKET: m1-fix2
NEXT: <origin/next sha after your last push>
## Merged
- <branch> -> <merge commit sha>
## Skipped
- <branch> -> <why, with the failing test or conflict>
## Bite checks
- <test> -> <the line that failed when the fix was reverted>
## Review notes
- <branch>: <bug or risk you saw in its diff, or "clean">
## Gate evidence
<last lines of the last `just check`, verbatim>
## Learnings
<what cost time, one line each>
```
