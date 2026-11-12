You close one hole in KaaS-team/KaaS-factory (Go, branch `next`). `factory packs run <pack.yaml>` loads the manifest with an empty hash (`LoadManifest(args[0], "")` in `cmd/factory`) and runs its `sh -c` checks without checking `factory.lock`, so an unreviewed pack file can run shell on the operator's machine.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. `just --version`. If `just` is missing, run the `check` recipe body from `justfile` by hand and say so in the report.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## Steps

1. `git fetch -q origin && git checkout -q -B next origin/next`. Find `LoadManifest` and every caller (`grep -rn LoadManifest --include=*.go`).
2. Test first: a pack whose path or sha256 is not in `factory.lock` is refused with an error naming the pack and the lock; a locked pack whose file hash differs is refused; a locked, matching pack runs. Use the lock resolver `internal/packs` already has; never add a second hash check.
3. Add an explicit `--unlocked` flag for local authoring that runs an unlocked pack and prints one warning line to stderr. No env var bypass.
4. Every other caller of `LoadManifest` with an empty hash: same rule, or a one-line comment saying why it is safe.
5. Bite check each test (revert, watch it fail, quote the line, restore). `go test -race -count=3 ./internal/packs/... ./cmd/factory/...`, `go run ./tools/ratchet`, `just check`, `git push origin HEAD:next` (retry rule). Update `docs/cli-reference.md` for the flag only.

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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m3-packs-lock"
```

Your final message is that same report:

```
TICKET: m3-packs-lock
NEXT: <origin/next sha after your last push>
## Fixed
- <behaviour> -> <commit sha, test name>
## Bite checks
- <test> -> <the line that failed when the fix was reverted>
## Other callers
- <file:line> -> <fixed or why safe>
## Gate evidence
<last lines of the last `just check`, verbatim>
## Learnings
<what cost time, one line each>
```
