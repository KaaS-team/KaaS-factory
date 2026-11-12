You fix a restart bug in KaaS-team/KaaS-factory (Go, branch `next`). The design rule (AGENTS.md, plan): the issue thread on GitHub is the only state; a restart rebuilds everything from GitHub plus the lease refs. But `internal/core/stage.go` keeps each ticket's workflow position (`stageRun`: node, base, fails, pr, input) only in the in-memory `c.stages` map, and `stageOf` starts a ticket at `g.Start` when the map has no entry. So after `factory serve` restarts, a ticket that was at `verify` or waiting on a human node runs from the first node again: duplicate sessions, duplicate PRs.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. `just --version`. If `just` is missing, run the `check` recipe body from `justfile` by hand and say so in the report.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## Steps

1. `git fetch -q origin && git checkout -q -B next origin/next`. Read `internal/core/stage.go`, `core.go` (where `c.stages` is filled and deleted), `internal/marker` (the one marker codec) and how the GitHub tracker writes and reads `<!-- factory:data -->` markers today.
2. Test first, in `internal/core` with the existing port fakes (`internal/api/porttest`): a ticket advances to its second node (and, in a second case, parks on a human node); throw the Core away; build a new Core on the same fake tracker; the ticket resumes at that node with the same `base` attempt count and `pr`, and no session for an earlier node is dispatched again. See it fail on `next`.
3. Persist the position through the tracker port when it changes (`advance`, `resume`, park on human): one versioned marker kind through `internal/marker` (no second codec), written as part of the comment the stage already posts if there is one, else its own. `stageOf` reads the latest such marker when the map has no entry. Unknown node name (workflow edited since): start at `g.Start` and emit one warning event; test it.
4. `history` (tutor attempts) may be rebuilt from existing attempt markers if they exist; if not, leave it empty and say so. Do not add fields to the marker that are not needed to resume.
5. Bite check (revert the read in `stageOf`, watch the test fail, quote the line, restore). `go test -race -count=3 ./internal/core/... ./internal/tracker/... ./internal/marker/...`, `go run ./tools/ratchet`, `just check` (see Setup), `git push origin HEAD:next` (retry rule).

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m3-graph-resume"
```

Your final message is that same report:

```
TICKET: m3-graph-resume
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
