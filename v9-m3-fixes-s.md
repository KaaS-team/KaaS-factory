You fix two sandbox defects a merge reviewer found on `next` of KaaS-team/KaaS-factory (Go). Each gets a test that fails without the fix.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. The gate is `./gate.sh` (the `check` recipe for hosts without `just`). It takes about 4 minutes; run it in the background.
3. Read `AGENTS.md`, `pkg/sandbox/egress/rules.go` and `pkg/sandbox/runsc.go`.
4. Set `git config user.name "KaaS factory"` and `git config user.email factory@kaas.team`, and commit with `git commit -s` so every commit carries a `Signed-off-by:` matching its author (the repo's DCO check refuses commits without one).

## Defects

1. **The egress SSRF guard misses non-public ranges.** `egress.NonPublic` (`pkg/sandbox/egress/rules.go:61`) lets through 6to4 `2002::/16` (whose embedded IPv4 can be private), Teredo `2001::/32`, `192.0.0.0/24`, `198.18.0.0/15` (benchmarking) and `240.0.0.0/4` (reserved), plus `100.64.0.0/10` (CGNAT) and NAT64 `64:ff9b::/96` if missing. Use `net/netip` prefixes from the IANA special-purpose registries; for 6to4 and NAT64, extract the embedded IPv4 and judge it. Tests: a table with one address per added range (blocked) and public controls `8.8.8.8`, `2606:4700::1111` (allowed).
2. **runsc is hashed, then executed by path.** `pkg/sandbox/runsc.go` checks the binary's SHA-256 and then execs the path, so a swap between check and exec runs an unchecked binary. Hash and execute the same bytes: copy the binary into a fresh private `0700` dir while hashing it, compare, then exec the copy (or open once and exec through `/proc/self/fd/N` on linux). Test: a fake runsc whose file is replaced after the hash (a hook in the test) still runs the checked bytes, or is refused; never the swapped ones.

Left for later, do not do: per-ticket refs in the Landlock jail.

## Steps

`git fetch -q origin && git checkout -q -B next origin/next`, then fix each defect test-first, one commit each. `go test -race -count=3` on touched packages, `go run ./tools/ratchet`, then `./gate.sh` once. Push with `git push origin HEAD:next`. On a rejection: `git fetch -q origin && git merge origin/next` (no rebase; resolve a conflict by hand, never loop on an unresolved one), `go build ./... && go vet ./...` plus the touched packages' tests, push again, up to 6 tries. Run `./gate.sh` once more after the last push and quote it.

Commit trailer: end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` after the `Signed-off-by:` line. This trailer is required and is the one allowed exception to the no-model-name rule, which covers commit subjects, bodies and files.
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
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m3-fixes-s"
```

Your final message is that same report:

```
TICKET: m3-fixes-s
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
