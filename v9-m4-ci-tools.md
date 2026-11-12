You port three pull-request checks of KaaS-team/KaaS-factory from the frozen TS tree to one Go tool, so CI keeps enforcing what `CONTRIBUTING.md` promises once the TS tree is deleted.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. The gate is `./gate.sh` (the `check` recipe for hosts without `just`). It takes about 4 minutes; run it in the background.
3. Read `AGENTS.md`, `CONTRIBUTING.md`, `tools/ratchet/main.go` and `.github/pull_request_template.md`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.
5. `git fetch -q origin --tags && git checkout -q -B next origin/next`. If `scripts/` is already gone, read the sources from tag `ts-final` (`git show ts-final:scripts/dco.ts`).

## Port

Sources (read only, never edit): `scripts/dco.ts`, `scripts/check-pr-body.ts`, `scripts/check-tests-only.ts`, and their tests `tests/check-pr-body.test.ts`, `tests/check-tests-only.test.ts`, `tests/pr-body-lint.test.ts`, `tests/pr-body.test.ts` (and any dco test you find).

Write `tools/prcheck` (package main, standard library only) with three subcommands that keep the TS behaviour and messages:

1. `go run ./tools/prcheck dco <base> <head>`: every commit in `base..head` has a `Signed-off-by:` trailer whose address matches the commit's author address.
2. `go run ./tools/prcheck body`: reads `PR_BODY` from the environment and fails when a section of `.github/pull_request_template.md` is missing or empty. It reads the section names from the template file, never a hard-coded copy.
3. `go run ./tools/prcheck tests-only <base> <head>`: a diff that weakens a test (as `check-tests-only.ts` defines it) fails unless `PR_BODY` states the reason the way the TS check requires.

Port every case from the TS tests as Go table tests (a temp git repo built in `t.TempDir()` for dco and tests-only). Add a line `Ported from scripts/<name>.ts at ts-final` at the top of each Go file.

## Do not touch

`.github/` (a local session rewrites the workflows to call this tool), `src/`, `tests/`, `scripts/`, `CONTRIBUTING.md`. Note in the report the exact command lines a workflow should run.

## Steps

Test-first, one commit per subcommand. `go test -race -count=3 ./tools/prcheck/`, `go run ./tools/ratchet`, then `./gate.sh` once. Push with `git push origin HEAD:next`. On a rejection: `git fetch -q origin && git merge origin/next` (no rebase), `go build ./... && go vet ./...` plus `go test ./tools/prcheck/`, push again, up to 6 tries. Run `./gate.sh` once more after the last push and quote it.

Commit trailer: end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. This trailer is required and is the one allowed exception to the no-model-name rule, which covers commit subjects, bodies and files.

## Quality bar (a reviewer reads your report against this)

- Every check gets a test that fails without it. Prove it: break the check (for example, accept a missing trailer), run the test, watch it fail, restore. Quote the failing line under "Bite checks".
- Never widen scope: no new rules beyond what the TS checks enforce. List what you left out.

## Rules

- Never `SKIP_GATE`, never force-push, never `--no-verify`.
- No `ANTHROPIC_*` or other provider key anywhere. No model name, token count or cost in a commit subject, body or file.
- No session URL, `claude.ai` link or `Claude-Session:` trailer in any commit or file.
- Do not open PRs, comment on issues or delete branches.
- `.ratchet.json` conflicts: take the larger `go_lines` and the larger `deadcode`, keep one reason line, then re-run `go run ./tools/ratchet` and raise again if needed.

## When you finish

Write the report to /tmp/report.md, then push it to its own branch (a repo hook refuses writes under `.factory/`):

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m4-ci-tools"
```

Your final message is that same report:

```
TICKET: m4-ci-tools
NEXT: <origin/next sha after your last push>
## Ported
- <subcommand> -> <commit sha, test names, TS cases covered of total>
## Bite checks
- <test> -> <the line that failed when the check was broken>
## Workflow lines
- <the exact run: lines for ci.yml>
## Left out
- <what and why>
## Gate evidence
<last lines of the last ./gate.sh, verbatim>
## Learnings
<what cost time, one line each>
```
