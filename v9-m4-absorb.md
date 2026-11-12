You bring `internal/mcp` of KaaS-team/KaaS-factory branch `next` to parity with the retired TS server KaaS-team/factory-mcp, so that repo can be archived.

## Setup

1. `go version`. `next` needs Go 1.26; if yours is older, `export GOTOOLCHAIN=auto`.
2. The gate is `./gate.sh` (`just` is usually missing in the cloud). It takes about 4 minutes; run it in the background and wait.
3. Read `AGENTS.md`, `internal/mcp/mcp.go`, `internal/mcp/mcp_test.go`, `internal/api` and `cmd/factory` (the `mcp` command).
4. `git fetch -q origin cloud-briefs && git show origin/cloud-briefs:v9-m4-absorb-ref.md` holds the TS sources: `tools.ts`, `http.ts`, `client.ts`, `contract.test.ts`, `http.test.ts`. Read them; that file is your only copy.
5. `git config user.name` and `user.email` must be set; if not, set them to `KaaS factory` and `factory@kaas.team`.
6. `git fetch -q origin && git checkout -q -B next origin/next`.

## Build (test-first, one commit each)

1. **Five tools**, each with the TS name, description and annotations (readOnly, destructive, idempotent, openWorld) unchanged: `create_task` (title, optional body), `hand_off_task` (id, to, optional note), `queue_followup` (id, message), `list_events` (id), `list_repos`. Each calls the core only through `internal/api` `Control` (AGENTS.md boundary). When `Control` has no method for one, add the smallest one to the interface, its `porttest` fake and the real implementation the CLI already wires; reuse an existing tracker or event path, never a second one. `spend` stays covered by the operator-only `report` tool; say so in the report and do not add it.
2. **HTTP transport**: `factory mcp --http <addr>` serves the go-sdk streamable HTTP handler at `/mcp`. Bearer token from env `FACTORY_MCP_TOKEN` (never a flag, never logged); an empty token refuses to start; a wrong or missing `Authorization` gets 401; any other path gets 404; the default bind is `127.0.0.1`. Compare the token in constant time.
3. **Contract test**: port every case of `contract.test.ts` and `http.test.ts` as Go table tests. Add one structural test that lists the registered tools and asserts the full TS tool set (`list_tasks`/`get_task`/`get_metrics` map to existing Go tools; name the mapping in the test) is present, so a dropped tool fails.

## Quality bar (a reviewer reads your report against this)

- Every new behaviour has a test that fails without it. Prove it: break it (return 200 on a bad token, drop a tool from the registry), run the test, watch it fail, restore. Quote each failing line under "Bite checks".
- Never widen scope: no new tools beyond the five, no new flags beyond `--http`. List what you left out.

## Do not touch

`.github/`, `src/`, `tests/`, `scripts/`. Do not edit the TS repo.

## Check and push

`go test -race -count=3 ./internal/mcp/ ./cmd/factory/`, `go run ./tools/ratchet` (raise with `--update` only for lines you added, and say so), then `./gate.sh`; it must exit 0. Push with `git push origin HEAD:next`. On a rejection: `git fetch -q origin && git merge origin/next` (no rebase; resolve conflicts by hand, never loop on an unresolved one), `go build ./... && go vet ./...` plus `go test ./internal/mcp/`, push again, up to 6 tries. Run `./gate.sh` once more after the last push and quote it.

## Rules

- Never `SKIP_GATE`, never force-push, never `--no-verify`.
- No `ANTHROPIC_*` or other provider key anywhere. No model name, token count or cost in a commit subject, body or file. No session URL, `claude.ai` link or `Claude-Session:` trailer.
- Do not open PRs, comment on issues, delete branches or touch `main`.
- `.ratchet.json` conflicts: take the larger `go_lines` and the larger `deadcode`, keep one reason line, re-run `go run ./tools/ratchet`.
- Commit trailer: end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. This trailer is required and is the one allowed exception to the no-model-name rule.

## When you finish

Write the report to /tmp/report.md, then push it to its own branch (a repo hook refuses writes under `.factory/`):

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-m4-absorb"
```

Your final message is that same report:

```
TICKET: m4-absorb
NEXT: <origin/next sha after your last push>
## Built
- <tool or transport> -> <commit sha, test names, TS cases covered of total>
## Bite checks
- <test> -> <the line that failed when the behaviour was broken>
## Control changes
- <method added to internal/api, and why no existing one fit>
## Left out
- <what and why>
## Gate evidence
<last lines of the last ./gate.sh, verbatim>
## Learnings
<what cost time, one line each>
```
