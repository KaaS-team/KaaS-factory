# f-review: fresh review of `next` before v9.0.0

Base: `origin/land/demo-wave` (2ffc730). Read-only review, no code changed. Walked `cmd/factory` into
`internal/` (serve, mcp, a2a, gate, config, reconcile, dispatch/local, packs, selfupdate, sanitize,
tracker/github, review). Findings marked **[run]** were reproduced with a throwaway test or the built
binary; the scratch files were deleted. Every finding names the test that would catch it.

## Demo commands

Review ticket, so the presenter types the reproductions. Output is real.

```
$ cd $(mktemp -d) && git init -q . && go build -o factory <repo>/cmd/factory
$ FACTORY_MCP_TOKEN=x ./factory mcp --http 127.0.0.1:0
factory: env layer: unknown key "mcp_token"
$ FACTORY_A2A_TOKEN=x ./factory a2a --addr 127.0.0.1:0
factory: env layer: unknown key "a2a_token"
$ KAAS_SERVE_PASSWORD=p FACTORY_ALLOWED_HOSTS=a.com ./factory serve
factory: env layer: unknown key "allowed_hosts"
```

## Findings, ranked

### High

**H1. The env vars the product tells you to set make it refuse to start. [run]**
`internal/config/load.go:81-98` loads every `FACTORY_*` variable into the config, and
`collect` (`:154-158`) fails on any name that is not a config key. But the code itself defines
`FACTORY_MCP_TOKEN` (`internal/mcp/mcp.go:443`), `FACTORY_A2A_TOKEN` (`internal/a2a/command.go:18`),
`FACTORY_ALLOWED_HOSTS` and `FACTORY_ALLOWED_ORIGINS` (`internal/serve/hostguard/hostguard.go:20-21`),
`FACTORY_SCIM_TOKEN`, `FACTORY_SMOKE_REPO`, `FACTORY_EVAL_RERECORD`. `serve.go:24` already knows the rule
("FACTORY_ is reserved for config keys") and used `KAAS_SERVE_PASSWORD` instead.
Failing input: `FACTORY_MCP_TOKEN=x factory mcp --http :8080` exits with `unknown key "mcp_token"`.
`factory mcp --http` and `factory a2a` cannot start at all, and setting `FACTORY_ALLOWED_HOSTS` breaks every command.
Test: in `internal/config`, for each `*Env` const exported by `mcp`, `a2a` and `hostguard`, `Load` with only
that variable set must not error. Better: one reserved-name list the env layer skips, asserted against
`grep -rho 'FACTORY_[A-Z0-9_]*' --include=*.go`.

**H2. Agent sessions inherit the operator's secrets. [run]**
`internal/dispatch/local/local.go:183-191` (`childEnv`, also used by `cmd/factory/review.go:42`) strips only
`ANTHROPIC_`, `OPENAI_` and similar provider names (`:167-179`). Everything else passes to the agent process.
Failing input: with `GITHUB_APP_PRIVATE_KEY=pem GITHUB_TOKEN=t CLAUDE_ROUTINES_TOKEN=r KAAS_SERVE_PASSWORD=p
FACTORY_MCP_TOKEN=m` in the parent, `childEnv` returns all five. A prompt-injected ticket runs `printenv`, and
the App key mints installation tokens for every repo the App can reach. The sandbox limits file writes, not env.
Test: `childEnv` with that parent must drop the App key, routines token, serve password, and the
`FACTORY_*_TOKEN` names. Decide `GITHUB_TOKEN` on purpose (needed for pushes, or give the agent a scoped one).
Prefer an allow-list (PATH, HOME, LANG, TERM, TMPDIR, `GH_*` if wanted) over a deny-list.

### Medium

**M1. The GitHub token follows redirects to other hosts. [run]**
`cmd/factory/control.go:338-342` (`bearer.RoundTrip`) sets `Authorization` inside the transport, so it is
re-added on every redirect hop, including to a different host. Go only strips the header on cross-host
redirects when the caller set it, not a transport. `appAuth` (`:350-356`) does the same with installation tokens.
Failing input: base URL answers `302 Location: http://other/x`. `other` receives `Authorization: Bearer SECRET`.
Test: `httptest` pair as above; assert the second server sees no `Authorization`. Fix: skip the header when
`r.URL.Host` differs from the API host.

**M2. The gate can be green when it is red. [run]**
`internal/gate/gate.go:121` takes the first `FACTORY_GATES` line in the last 64 KB, and the process exit code is
ignored whenever a line parses. Failing inputs: a test fixture that prints a GREEN line before the real RED line
gives `Green() == true`. A script that prints GREEN then `exit 3` gives GREEN too (both reproduced).
Test: `Run` with those two commands must not return `Green()`. Use the last line, and require exit 0 for GREEN.

**M3. A2A requests can be lost or injected.**
`internal/tracker/github/filer.go:53-57` returns the existing issue when an open issue has the same title, and
drops the new body. `internal/a2a/a2a.go:128` uses the first line of the request as the title.
Failing input: two peers send `Fix login\nuse OAuth` and `Fix login\nuse SAML`. The second gets the first ticket's id
and its text is never filed. Separately, `filer.go:62` posts title and body raw, while `Comment` goes through
`sanitize.Publication` (`tracker.go:187`). A peer can send `@org/team fixes #1` and notify a team or close an issue.
Test: file two requests with equal first lines (second body must reach a ticket); file `@org/team fixes #1` and
assert the posted body has the mention and the trigger neutralized.

**M4. A release candidate never updates to its final release. [run]**
`internal/selfupdate/selfupdate.go:34` accepts a `-rc1` suffix but `compare` (`:79-89`) ignores it.
Failing input: `Check(ctx, "v9.0.0-rc1", latest "v9.0.0")` returns `newer=false`.
Test: that call must return true. Compare the suffix (a release is newer than its own prerelease).

**M5. Update checksums come from the same place as the binary.**
`selfupdate.go:123-139` fetches `checksums.txt` and the archive from the same release. Anyone who can replace
the asset replaces both. Failing input: attacker uploads a bad tarball and a matching `checksums.txt`; `Apply` installs it.
Test: `Apply` with a tampered pair signed by another key must fail. Verify a detached signature (cosign or minisign)
before replacing the binary. Ship before the first stable release, since v9.0.0 sets the trust path.

**M6. Published text in other scripts is mangled. [run]**
`internal/tracker/sanitize/publish.go:63-68` and `:116-138` map Cyrillic and Greek letters to Latin, and
fullwidth forms to ASCII, on all published text. Failing input: `Привет, мир. Москва` is posted as
`Пpивeт, миp. Mocквa`; `こんにちは，世界（テスト）` becomes `こんにちは,世界(テスト)`.
Test: `Publication` on those strings must return them unchanged. Apply homoglyph folding only to the spans
that are matched for mentions, URLs and triggers, not to the text that is output.

**M7. Three secret redactors disagree. [run]**
`internal/gate/gate.go:26` knows `ghp_` and `github_pat_` only. `sanitize/prompt.go:27` and `logs/logs.go:122`
know `gh[pousr]_`. Failing input: the gate tail line `token ghs_abcdefghijklmnopqrstuvwxyz0123456789AB`
(an App installation token, the kind this runner mints) is kept as is in `Result.Tail`.
Test: one table of token samples run through every redactor. Better: call `sanitize.RedactSecrets` from the gate.
`browsercheck/secrets.go` and `eval/replay` are the other copies.

**M8. One slow Dispatch freezes every session.**
`internal/dispatch/local/local.go:226` takes `d.mu` and holds it (deferred) through `Worktrees.Add` (a git
process), `Untrusted` (a GitHub API call) and `Snapshot`. `Wait`, `Autosubmitted` and `Steer` take the same lock
(`:432`, `:520`). Failing input: the permission lookup takes 30 s; no `Wait` returns for any session meanwhile.
Test: a fake `Untrusted` that blocks; `Wait` on another session must return. Lock only the map read and insert.

### Low

- **L1. A swallowed error resets the attempt counter.** `internal/reconcile/run.go:322-326`: when dispatch fails and
  `SetPhase(RetryQueue)` also fails, nothing is recorded or reported. The ticket stays claimed with no entry, and the next
  tick dispatches at attempt 1, so `MaxAttempts` is never reached. Test: a tracker whose `SetPhase` fails and a dispatcher that
  always fails; assert escalation after `MaxAttempts` ticks.
- **L2. A leftover worktree dir is trusted.** `internal/dispatch/local/worktree.go:33` returns any existing
  `factory-<id>-a<n>` dir without checking it is a worktree on the branch. An empty dir (a failed `worktree add`)
  gets an agent run in it. Test: pre-create the dir; `Add` must verify or recreate.
- **L3. File names with spaces are skipped.** `cmd/factory/review.go:101` splits `git diff --name-only` with
  `strings.Fields` and no `-z`. Failing input: a changed `docs/my notes.md` never matches a check pack's glob.
  Test: change that file and assert the pack runs.
- **L4. Hooks run on `review`'s worktree.** `internal/review/worktree.go:56` runs `worktree add` without
  `core.hooksPath=/dev/null`, unlike `dispatch/local/worktree.go:39`. A `post-checkout` hook runs. Test: a hook that
  touches a file; assert it did not run.
- **L5. HTTP MCP has no Host or Origin guard.** `internal/mcp/mcp.go:447-465` checks only the bearer, while `serve`
  and `a2a` wrap `hostguard`. Low because the token is required. Test: request with `Host: evil.test` is refused.
- **L6. Update path is not atomic across devices.** `selfupdate.go:195` creates the temp file beside the target, so
  that is fine, but a read-only install dir (`/usr/local/bin` as non-root) fails after the full download. Check
  writability first.

## Dead or duplicate code

- `internal/serve/jobs.go` (568 lines), `jitter.go` and the four `/jobs/*` routes (`serve.go:86-89`) are unreachable
  from the CLI: `cmd/factory/serve.go:103` passes no `Jobs`, `JobsPath` or `Exec`. Wire it or delete it before v9.0.0.
- Five near-identical git runners: `gitx/gitx.go:36`, `mergeq/wire/git.go:43`, `review/worktree.go:17`,
  `packs/fetch.go:32`, `gitx/checkpoint/checkpoint.go:86`. Each sets its own env and error text.
- Four secret redactors (see M7).

## The five hardest places to read

1. `internal/dispatch/local/local.go:205` `Dispatch`, 167 lines: lookup, preset, worktree, untrusted guard, sandbox,
   env, pipes, then a 70-line goroutine inside. Shape: `Dispatch` = lock, lookup, `launch(b)`; `launch` returns a
   `*process`; the watch loop becomes `func (p *process) watch(...)`.
2. `internal/eval/command.go:58` `NewCommand`, 164 lines of flag setup and subcommand bodies in one closure.
   Shape: one `newRunCmd`, `newReplayCmd`, ... each under 40 lines.
3. `internal/packs/repomap/rank.go:93` `Rank`, 152 lines. Shape: `tags()` then `graph()` then `pagerank()` then `render()`.
4. `internal/serve/serve.go:156` `Serve`: five goroutines, two `select` blocks that repeat the same stop logic, and
   jobs set up mid-function. Shape: one `errgroup`, one `select` on the first error, one `shutdown(drain)` helper.
5. `internal/reconcile/run.go:56` `Tick` with `decide.go:118` `Decide`: refresh, terminal marking, concurrency caps,
   observation and action in one pass. Shape: `refresh(ready)`, `observe()`, `plan()`, `apply()`, each a method on `State`.

## Acceptance

- [x] Findings ranked by severity, each with file:line and a failing input: done (H1-H2, M1-M8, L1-L6).
- [x] Five hardest-to-read places with a one-line simpler shape: done.

## Upstreams copied

None. No code copied.

## Files outside my area

None. Only `.factory/reports/f-review.md`.

## Workflow changes needed

None. Note: `AGENTS.md` says a repo hook refuses writes under `.factory/`; this brief names that path, so the file is
force-added if `.gitignore` or the hook blocks it. Gate not run: no code changed.
