You fix two defects a merge reviewer found on `next` of KaaS-team/KaaS-factory (Go). Each gets a test that fails without the fix.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. The gate is `./gate.sh` (the `check` recipe for hosts without `just`). It takes about 4 minutes; run it in the background.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## Defects

1. **A signed policy without `expires_at` never expires.** `ee/policy` (`LoadSigned`, `Check`) refuses an expired policy, but a signed policy with no `expires_at` is valid forever, so a leaked old signed policy can be replayed. Make `expires_at` required for `LoadSigned`: a signed policy without it is refused with a clear error. Keep unsigned local policies as they are. Update the shipped example policies and goldens to carry an `expires_at`. Tests: a signed policy without `expires_at` is refused; one with a future `expires_at` loads.
2. **Agent session commits stage everything.** `git add -A` stages every untracked file in the agent worktree before a commit or patch: `internal/dispatch/local/autosubmit/autosubmit.go:121`, `internal/packs/checkmd/run.go:91` and `:166`, `internal/review/worktree.go:75` and `:110`. A file the agent wrote by mistake (a `.env`, a key file, a dump) lands in the PR. Add one shared helper (one resolver, used by all five call sites) that stages with `git add -A`, then lists the staged paths and unstages and refuses any path that matches a secret-file pattern (`.env`, `.env.*` except `.env.example`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `credentials*.json`, `.npmrc`, `.netrc`). Reuse an existing secret-path list in the repo if one exists (`rg -n "\.pem|id_rsa" --type go`) rather than adding a second. Tests: the helper refuses a worktree with a new `.env` and a `deploy.pem` and leaves them unstaged; a normal source change stages; each of the five call sites goes through the helper (a test that greps the package sources for a raw `"add", "-A"` outside the helper and fails if it finds one).

## Steps

`git fetch -q origin && git checkout -q -B next origin/next`, then fix each defect test-first, one commit each. `go test -race -count=3` on touched packages, `go run ./tools/ratchet`, then `./gate.sh` once. Push with `git push origin HEAD:next`. On a rejection: `git fetch -q origin && git merge origin/next` (no rebase), `go build ./... && go vet ./...` plus the touched packages' tests, push again, up to 6 tries. Run `./gate.sh` once more after the last push and quote it.

Commit trailer: end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. This trailer is required and is the one allowed exception to the no-model-name rule, which covers commit subjects, bodies and files.

## Quality bar (a reviewer reads your report against this)

- Every behaviour you add or fix gets a test that fails without it. Prove it: revert the fix line, run the test, watch it fail, restore. Quote the failing line in the report under "Bite checks".
- Run `go test -race -count=3` on every package you touched, so a flake shows up here and not in the next session.
- Never widen scope: no refactor, rename or doc rewrite the defects do not need. List what you left out.

## Rules

- Never `SKIP_GATE`, never force-push, never `--no-verify`. Never edit the TS tree (`src/`, `tests/`, `dashboard/`, `scripts/`) or `.github/`.
- No `ANTHROPIC_*` or other provider key anywhere. No model name, token count or cost in a commit subject, body or file.
- No session URL, `claude.ai` link or `Claude-Session:` trailer in any commit or file.
- Do not open PRs, comment on issues or delete branches.
- `.ratchet.json` conflicts: take the larger `go_lines` and the larger `deadcode`, keep one reason line, then re-run `go run ./tools/ratchet` and raise again if needed.
- `THIRD_PARTY_NOTICES.md` and `NOTICE` conflicts: keep both sides' sections. `go.mod`/`go.sum`: keep both sides' requires, then `go mod tidy`.
- `internal/a2a/a2a-audit.jsonl` may be tracked on `next`; if a merge stops on it as an untracked file, delete your local copy.

## When you finish

Write the report to /tmp/report.md, then push it to its own branch (a repo hook refuses writes under `.factory/`):

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m3-fixes-b2"
```

Your final message is that same report:

```
TICKET: m3-fixes-b2
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
