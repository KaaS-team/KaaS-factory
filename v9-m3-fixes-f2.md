You fix four defects a merge reviewer found on `next` of KaaS-team/KaaS-factory (Go). Each gets a test that fails without the fix.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. The gate is `./gate.sh` (the `check` recipe for hosts without `just`). It takes about 3 minutes; run it in the background.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## Defects

1. **Spend cap ignores per-day spend.** `Gate.Allow` (merged from `go/k8-spend-cap`) counts only ledger rows with `Day == ""` for the team holder, so spend recorded per day never counts toward the cap. Count the rows in the cap's window (today's day rows plus undated rows for the team) through one resolver for "rows in this window". Test: a ledger with only per-day rows at or over the cap refuses the next session.
2. **The untrusted-PR guard restores settings from the PR's own checkout.** `internal/dispatch/untrusted` restores the recorded settings paths to the checkout state, which is the untrusted PR's version. Restore them from the base branch (`git show <base>:<path>`, or remove the file when the base has none), and start the untrusted run with settings read from the base. Test: a PR checkout whose project settings file allows `Bash(*)` ends the run with the base branch's allow list, not the PR's.
3. **`Config.Untrusted` is never used.** Wire it in `cmd/factory` so a run on a PR from an untrusted author goes through `untrusted.Restrict` and the guard (find where trust is decided: the GitHub tracker's trust code and the dispatch path). Test at the command or dispatch level: an untrusted author's run gets the restricted argv; a trusted one does not.
4. **`internal/a2a/a2a-audit.jsonl` is tracked on `next`.** If it is still tracked when you start, `git rm --cached` it, add it to `.gitignore`, and make the a2a tests write under `t.TempDir()`. If `m3-fixes-k5` already did this, say so and skip.

## Steps

`git fetch -q origin && git checkout -q -B next origin/next`, then fix each defect test-first, one commit each. `go test -race -count=3` on touched packages, `go run ./tools/ratchet`, then `./gate.sh` once. Push with `git push origin HEAD:next`. On a rejection: `git fetch -q origin && git merge origin/next` (no rebase), `go build ./... && go vet ./...` plus the touched packages' tests, push again, up to 6 tries. Run `./gate.sh` once more after the last push and quote it.

Commit trailers: end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Quality bar (a reviewer reads your report against this)

- Every behaviour you add or fix gets a test that fails without it. Prove it: revert the fix line, run the test, watch it fail, restore. Quote the failing line in the report under "Bite checks".
- Run `go test -race -count=3` on every package you touched, so a flake shows up here and not in the next session.
- Never widen scope: no refactor, rename or doc rewrite the defects do not need. List what you left out.

## Rules

- Never `SKIP_GATE`, never force-push, never `--no-verify`. Never edit the TS tree (`src/`, `tests/`, `dashboard/`, `scripts/`) or `.github/`.
- No `ANTHROPIC_*` or other provider key anywhere. No model name, token count or cost in a commit or file.
- No session URL, `claude.ai` link or `Claude-Session:` trailer in any commit or file.
- Do not open PRs, comment on issues or delete branches.
- `.ratchet.json` conflicts: take the larger `go_lines` and the larger `deadcode`, keep one reason line, then re-run `go run ./tools/ratchet` and raise again if needed.
- `THIRD_PARTY_NOTICES.md` and `NOTICE` conflicts: keep both sides' sections. `go.mod`/`go.sum`: keep both sides' requires, then `go mod tidy`.

## When you finish

Write the report to /tmp/report.md, then push it to its own branch (a repo hook refuses writes under `.factory/`):

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m3-fixes-f2"
```

Your final message is that same report:

```
TICKET: m3-fixes-f2
NEXT: <origin/next sha after your last push>
## Fixed
- <defect> -> <commit sha, test name>
## Bite checks
- <test> -> <the line that failed when the fix was reverted>
## Not fixed
- <defect> -> <why>
## Gate evidence
<last lines of the last ./gate.sh, verbatim>
## Learnings
<what cost time, one line each>
```
