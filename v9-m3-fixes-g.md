You resolve duplicates and fix review findings from the m1-g merge session on `next` of KaaS-team/KaaS-factory (Go). Rule from the engineering standard: one resolver per concept, no second source of truth.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. `just --version`. If `just` is missing, run the `check` recipe body from `justfile` by hand and say so in the report.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## Work

1. **`go/k9-stall` duplicates the stuck detector.** `next` already has `internal/dispatch/local/stuck` (Nudge/Abort on the stdout loop). The branch adds a second, separate detector. Do not merge the branch. Diff its behaviour against `stuck` and list what it does that `stuck` does not. Port each such behaviour into `stuck`, test-first, citing the branch file in the commit. If there is nothing, say so. The `stuck` package may be edited at the same time by the m3-fixes-k5 session (nudge reset, abort-vs-exit race): fetch and merge `origin/next` before you start and before each push.
2. **`go/k10-catchup` duplicates the serve scheduler.** `next` already has Jobs (cron, catch-up, cursor) in `internal/serve`. The branch adds a second Scheduler (cron, catch-up, jitter). Do not merge it. Port what is missing, likely jitter, into the existing Jobs, test-first, the same way as in step 1.
3. **`go/k9-workflow-md` (on next): symlinked import escapes the directory.** Imports are checked with `filepath.IsLocal`, but `os.ReadFile` follows symlinks. Resolve the path with `filepath.EvalSymlinks` (or open it through `os.Root`) and refuse a target outside the workflow dir. Test with a symlink to a file outside the dir.
4. **`checkNoWriteCredential` is a name heuristic.** It catches TOKEN, SECRET, _KEY and :write, and misses PASSWORD, GH_PAT, PAT and similar. Widen the list from one table, and add a table test covering each name.
5. Do not delete the two duplicate branches. In the report, list them as superseded and say where each behaviour now lives.

## Steps

Bite-check each fix: revert it, quote the failing line, restore. Then:
- `go test -race -count=3` on the touched packages;
- `go run ./tools/ratchet`;
- `./gate.sh`;
- `git push origin HEAD:next`. On a rejection, merge fresh `origin/next`, re-run build, vet and the touched tests, and push again. Up to 8 tries.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m3-fixes-g"
```

Your final message is that same report:

```
TICKET: m3-fixes-g
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
