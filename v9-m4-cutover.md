You do the cutover of KaaS-team/KaaS-factory branch `next` to Go only: delete the frozen v8 TypeScript tree and everything only it uses, so the repo holds one product. Param approved this cutover.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. Use `./gate.sh` for the gate (`just` is usually missing in the cloud). It takes over 2 minutes; run it in the background and wait.
3. Read `AGENTS.md`, `gate.sh`, `justfile` and `.goreleaser.yaml`.
4. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.
5. `git fetch -q origin && git checkout -q -B go/m4-cutover origin/next`.

## Delete

1. The TS tree and its tooling: `src/`, `tests/`, `dashboard/`, `scripts/`, `relay/`, `verify/`, `packages/`, `Makefile`, `make/`, `package.json`, `bun.lock`, `bunfig.toml`, `biome.json`, `tsconfig.json`, `goals.json`, `quality-baseline.json`, `ci/` (a drifting copy of `.github/`).
2. Anything else only the TS tree uses. For each of `bin/`, `contrib/`, `install/`, `integrations/`, `packaging/`, `template-ci/`, `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `.dockerignore`, `ee/`, `LICENSES/`, `REUSE.toml`, `docs/` and `.agents/repo.json`: `grep` who references it. Delete it when only TS files, deleted files or bun/node commands use it. Keep it when Go code, `justfile`, `gate.sh`, `.goreleaser.yaml`, `template/`, `packs/` or `evals/` use it, and rewrite TS-only lines inside it (a Dockerfile that builds with bun becomes a static Go build from `.goreleaser.yaml`'s binary, or is deleted if goreleaser has no image). List every keep or delete decision with its reason in the report.
3. Doc lines about the TS tree: `AGENTS.md` (the "frozen v8 tree" paragraph and any TS path), `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `SECURITY.md`. Install and quick start must name only the Go binary. `CHANGELOG.md` gets one entry: "v9: Go rewrite; the v8 TypeScript tree is removed (tag ts-final)."
4. `tools/ratchet` skips `src/`; remove that skip and its test case now that `src/` is gone. Run `go run ./tools/ratchet --update` so the ceilings drop to the measured values and set `reason` to "lowered at the cutover".

## Do not touch

- `.github/` (cloud tokens cannot push workflows; a local session rewrites them). Note in the report which workflow steps still call bun, make or `src/` so that session can fix them.
- Go packages, `template/`, `packs/`, `evals/`, `THIRD_PARTY_NOTICES.md` (only drop a section whose files you deleted, and the `internal/provenance` test must stay green).

## Check and push

1. `rg -n "bun |bunx|\bsrc/|tsconfig|package\.json" --glob '!.github/**' --glob '!CHANGELOG.md'` lists nothing left that points at the deleted tree. Quote its output in the report.
2. `go build ./... && go vet ./...`, then `./gate.sh`; it must exit 0.
3. `CGO_ENABLED=0 go build -o /tmp/factory ./cmd/factory && /tmp/factory --help && /tmp/factory version`.
4. Push to `go/m4-cutover` first (`git push origin HEAD:go/m4-cutover`), then merge into `next`: `git fetch -q origin && git checkout -q -B next origin/next && git merge --no-ff --no-edit go/m4-cutover`. On a conflict from a file another session changed under a deleted directory, keep the delete. Run `go build ./... && go vet ./...` and push `HEAD:next`. On a rejection: `git fetch -q origin && git merge origin/next` (no rebase), build and vet again, push again, up to 6 tries. Run `./gate.sh` once more after the last push and quote it.

## Rules

- Never `SKIP_GATE`, never force-push, never `--no-verify`. Do not edit `.github/`.
- No `ANTHROPIC_*` or other provider key anywhere. No model name, token count or cost in a commit or file. No session URL or `Claude-Session:` trailer.
- Do not open PRs, comment on issues, delete branches or tags, or touch `main`.
- Commit trailer: end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. This trailer is required and is the one allowed exception to the no-model-name rule.

## When you finish

Write the report to /tmp/report.md, then push it to its own branch (a repo hook refuses writes under `.factory/`):

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m4-cutover"
```

Your final message is that same report:

```
TICKET: m4-cutover
NEXT: <origin/next sha after your last push>
## Deleted
- <path> -> <why>
## Kept
- <path> -> <who uses it>
## Workflows to fix locally
- <workflow file:line> -> <what still calls TS>
## Gate evidence
<last lines of the last ./gate.sh, verbatim, and the rg output>
## Learnings
<what cost time, one line each>
```
