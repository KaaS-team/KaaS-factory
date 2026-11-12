You merge reviewed session branches into `next` of KaaS-team/KaaS-factory (Go, branch `next`). A laptop did this until now, and its gate is too slow under load, so you take over for these branches: `go/k3f-state`, `go/k3f-graph`

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. `just --version`. If `just` is missing, run the `check` recipe body from `justfile` by hand and say so in the report.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## For each branch, in order

1. `git fetch -q origin && git checkout -q -B next origin/next`.
2. `git merge --no-ff --no-edit origin/go/<branch>`. On a conflict, read both sides and keep both intents (see the conflict rules below). If a conflict needs a design decision you cannot make from the code, `git merge --abort`, record the branch under Skipped and move on.
3. Review the branch's diff (`git diff origin/next...origin/go/<branch>`) as a merge reviewer: security holes (SSRF, path traversal, command injection, a guard that can be bypassed), a test that cannot fail, a claim in a comment the code does not do. Fix a small real bug in a follow-up commit with a test that fails without the fix; note bigger ones under Review notes.
4. `go mod tidy`, then `go run ./tools/ratchet`. If it reports a count above the baseline, raise `.ratchet.json` to the measured values and set `reason` to "raised by the reviewed merge of go/<branch> (session packages not yet wired into cmd/factory); lowered by go run ./tools/ratchet --update, a raise needs a hand edit and a new reason here". Commit it as `ratchet: ceilings after <branch>`.
5. `just check`. A failing test introduced by the branch: fix it if the fix is small and inside the branch's own packages; otherwise reset to `origin/next` and Skip. A test that fails on `origin/next` too is not yours: note it and Skip only if it blocks the push.
6. `git push origin HEAD:next`. On a rejection follow the retry rule.

Commit trailers: end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## These branches change the core

They were built in parallel with branches already merged into `next`, so `internal/core`, `cmd/factory`, the GitHub tracker and `gitx` have moved under them. Before each merge, read `git log --oneline origin/go/<branch>` and the branch's own report (`git show origin/report/v9-<branch>:report.md` if it exists) so you know its intent. Resolve conflicts by keeping what `next` already does and adding the branch's intent on top of `next`'s types; never revert a `next` feature to make a branch fit. If the two designs truly disagree, skip that branch with a one-paragraph note naming both functions.

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
- Several merge sessions push to `next` at the same time. A rejected push is normal: `git fetch -q origin`, `git rebase origin/next` (or redo the merge on a fresh `origin/next`), re-run `just check`, push again. Up to 6 tries per branch.
- `.ratchet.json` conflicts: take the larger `go_lines` and the larger `deadcode`, keep one reason line, then re-run `go run ./tools/ratchet` and raise again if needed.
- `THIRD_PARTY_NOTICES.md` and `NOTICE` conflicts: keep both sides' sections. `go.mod`/`go.sum`: keep both sides' requires, then `go mod tidy`.

## When you finish

Write the report to /tmp/report.md, then push it to its own branch (a repo hook refuses writes under `.factory/`):

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m2-k3a"
```

Your final message is that same report:

```
TICKET: m2-k3a
NEXT: <origin/next sha after your last push>
## Merged
- <branch> -> <merge commit sha>
## Skipped
- <branch> -> <why, with the failing test or conflict>
## Already on next
- <branch> -> <evidence>
## Bite checks
- <test> -> <the line that failed when the fix was reverted>
## Review notes
- <branch>: <bug or risk you saw in its diff, or "clean">
## Gate evidence
<last lines of the last `just check`, verbatim>
## Learnings
<what cost time, one line each>
```
