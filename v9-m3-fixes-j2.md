You fix seven defects a merge reviewer found on `next` of KaaS-team/KaaS-factory (Go). Each gets a test that fails without the fix.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. The gate is `./gate.sh` (the `check` recipe for hosts without `just`). It takes about 4 minutes; run it in the background.
3. Read `AGENTS.md` and `tools/ratchet/main.go`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.

## Defects

1. **A resume with no stored interrupt skips schema validation.** `core.answer` swallows `ErrNothingPending` from the graph interrupt store, so the answer is accepted without being checked against the interrupt's schema. Return the error to the caller (the chatops reply says nothing is waiting). Test: answering a ticket with no pending interrupt is refused and nothing advances.
2. **Encrypted store accepts plaintext rows.** In the store-crypt layer, a row whose Type lacks the `+aesgcm` tag is returned as plaintext, so anyone with write access to the database can plant an unauthenticated row. When a key is configured, refuse untagged rows with a clear error (no plaintext in the error). Keep reading untagged rows only when no key is configured. Test: with a key set, a planted untagged row errors; a tagged row round-trips.
3. **Trajectory file names collide.** The trajectory `FileName` maps `a/b` and `a-b` to the same file, so one trajectory silently overwrites another. Make the mapping injective (escape the separator, or append a short hash of the raw id). Test: `a/b` and `a-b` get different files and both load.
4. **Trajectory submission is not verified.** `Load`'s replay compares the last step diff to the checksum but never the `submission` field, so editing `submission` alone is not detected, and a file with a submission but no step diff fails to load. Verify `submission` against the checksum too, and load a submission-only file. Tests for both.
5. **`eval.Replay` dereferences `Triggered` without a nil check.** It is exported, so a caller not using `trace.Read` can panic it. Return an error for a nil `Triggered`. Test: a hand-built line with nil `Triggered` errors, no panic.
6. **Trace files are world-readable.** The trace writer creates files with the default mode (0666 under umask). Create them 0600, since traces can hold prompts and tool output. Test: the created file's mode is 0600.
7. **Two restart mechanisms, never tested together.** `stageOf` tries memory, then the checkpoint store (when `Stages.Checkpoints` is set), then the thread position marker, then the graph start. Add a test with both a checkpoint and a thread position set, where they disagree, and assert the documented order wins. If the order is wrong for correctness (the thread position is the newer, GitHub-held truth), fix it and say why in the report.

Also, not a fix: report the age, maintainer and licence of the new `elimity-com/scim` dependency (pinned to a pseudo-version dated 2026-11-12) under "Dependency check". Do not change it.

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

## When you finish

Write the report to /tmp/report.md, then push it to its own branch (a repo hook refuses writes under `.factory/`):

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m3-fixes-j2"
```

Your final message is that same report:

```
TICKET: m3-fixes-j2
NEXT: <origin/next sha after your last push>
## Fixed
- <defect> -> <commit sha, test name>
## Bite checks
- <test> -> <the line that failed when the fix was reverted>
## Not fixed
- <defect> -> <why>
## Dependency check
- elimity-com/scim: <age, maintainer, licence, verdict>
## Gate evidence
<last lines of the last ./gate.sh, verbatim>
## Learnings
<what cost time, one line each>
```
