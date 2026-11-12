You are one of 10 agents working in parallel: 5 wire or shed slices of the factory on `next`, 1 audits it against the plan, 4 shed the satellite repos. Stay inside your area. Where your area grants an existing package or a cmd file, that grant overrides the general never-edit rule in the common section. Several sessions add one line to `cmd/factory/main.go` or `internal/core`; keep such edits to the fewest lines so the supervisor can merge them.

## Ticket: every shipped command and pack runs

`serve` and `a2a` have commands nobody mounts. `packs/checks/browser/pack.yaml` runs `factory browsercheck`, which does not exist.
`pkg/sandbox` exists and the local dispatcher does not use it. `selfupdate` and `githubauth` exist and `factory upgrade` and the GitHub
connection do not use them.

Your functions:
- `cmd/factory/serve.go:17:6 newServe`
- `internal/a2a/a2a.go:66:6 stateForPhase`
- `internal/a2a/a2a.go:72:6 agentCard`
- `internal/a2a/a2a.go:104:18 server.SendMessage`
- `internal/a2a/a2a.go:123:18 server.GetTask`
- `internal/a2a/a2a.go:128:18 server.task`
- `internal/a2a/a2a.go:151:18 server.prURL`
- `internal/a2a/a2a.go:169:6 titleOf`
- `internal/a2a/a2a.go:178:16 server.ListTasks`
- `internal/a2a/a2a.go:182:16 server.CancelTask`
- `internal/a2a/a2a.go:186:6 unsupported`
- `internal/a2a/a2a.go:188:16 server.SubscribeToTask`
- `internal/a2a/a2a.go:192:16 server.SendStreamingMessage`
- `internal/a2a/a2a.go:196:16 server.GetTaskPushConfig`
- `internal/a2a/a2a.go:200:16 server.ListTaskPushConfigs`
- `internal/a2a/a2a.go:204:16 server.CreateTaskPushConfig`
- `internal/a2a/a2a.go:208:16 server.DeleteTaskPushConfig`
- `internal/a2a/a2a.go:212:16 server.GetExtendedAgentCard`
- `internal/a2a/a2a.go:218:6 NewHandler`
- `internal/a2a/auth.go:11:6 bearer`
- `internal/a2a/command.go:26:6 NewCommand`
- `internal/browsercheck/run.go:21:6 LookChrome`
- `internal/browsercheck/run.go:45:17 Result.Line`
- `internal/browsercheck/run.go:54:6 Run`
- `internal/browsercheck/run.go:102:6 runStep`
- `internal/browsercheck/steps.go:24:6 ParseSteps`
- `internal/browsercheck/steps.go:46:6 parseStep`
- `internal/githubauth/githubauth.go:52:6 KeyFromFile`
- `internal/githubauth/githubauth.go:62:6 KeyFromEnv`
- `internal/githubauth/githubauth.go:70:15 App.now`
- `internal/githubauth/githubauth.go:78:15 App.JWT`
- `internal/githubauth/githubauth.go:100:6 parseKey`
- `internal/githubauth/githubauth.go:121:15 App.Token`
- `internal/selfupdate/selfupdate.go:51:6 Check`
- `internal/selfupdate/selfupdate.go:67:6 parseVersion`
- `internal/selfupdate/selfupdate.go:79:6 compare`
- `internal/selfupdate/selfupdate.go:92:6 AssetName`
- `internal/selfupdate/selfupdate.go:100:6 Apply`
- `internal/selfupdate/selfupdate.go:147:6 checksumFor`
- `internal/selfupdate/selfupdate.go:161:6 extractBinary`
- `internal/selfupdate/selfupdate.go:186:6 replaceExecutable`
- `internal/selfupdate/selfupdate.go:235:23 GitHubSource.Latest`
- `internal/selfupdate/selfupdate.go:254:23 GitHubSource.Asset`
- `internal/selfupdate/selfupdate.go:262:23 GitHubSource.get`
- `internal/serve/serve.go:29:18 realClock.Now`
- `internal/serve/serve.go:50:6 New`
- `internal/serve/serve.go:60:18 Server.markTick`
- `internal/serve/serve.go:67:18 Server.Handler`
- `internal/serve/serve.go:76:18 Server.healthz`
- `internal/serve/serve.go:92:18 Server.readyz`
- `internal/serve/serve.go:101:18 Server.events`
- `internal/serve/serve.go:138:18 Server.Serve`
- `internal/serve/serve.go:194:18 Server.stopHTTP`
- `pkg/sandbox/enter_darwin.go:14:6 Probe`
- `pkg/sandbox/enter_darwin.go:19:6 enter`
- `pkg/sandbox/plan.go:23:6 MakePlan`
- `pkg/sandbox/rules.go:41:6 LandlockRules`
- `pkg/sandbox/rules.go:68:6 DarwinProfile`
- `pkg/sandbox/rules.go:83:6 sbplQuote`
- `pkg/sandbox/sandbox.go:67:6 Command`
- `pkg/sandbox/sandbox.go:89:6 MaybeEnter`
- `pkg/sandbox/sandbox.go:112:17 Report.String`
- `pkg/sandbox/sandbox.go:115:17 Report.Has`
- `pkg/sandbox/sandbox.go:118:6 NewReport`
- `pkg/sandbox/unix.go:10:6 applyRlimits`

## Acceptance

- [ ] `TestRootCommandTree` lists `serve`, `a2a` and `browsercheck`, and each is mounted.
- [ ] The browser pack's command line parses against the mounted command (a test reads `pack.yaml` and runs `newRoot()` with
      `--help` on it).
- [ ] The local dispatcher runs its agent through `sandbox.Command` when config `sandbox: true` (default on where `Probe` says it can
      enforce); `MaybeEnter` is called first in `main`. Test: the built argv/env goes through the sandbox and carries no `ANTHROPIC_*`.
- [ ] `factory upgrade` uses `selfupdate` (fake release source in the test). GitHub App auth is used when its config keys are set,
      otherwise `GITHUB_TOKEN` as today. If either cannot be wired cleanly, delete it and say so.

## Why this wave exists

An audit of `next` found 230 functions no product path reaches (`go run golang.org/x/tools/cmd/deadcode@v0.39.0 ./...`). The factory's
non-test Go is about 20K lines against a plan budget of 8K. Pieces were ported and tested but never connected, so the binary does
less than the code claims. This wave makes every slice either reachable from `cmd/factory` or gone.

## The rule: wire it or delete it

For each function in your list:
1. If it serves a factory feature the plan keeps (list below) and a real command path should reach it, wire it with the smallest call
   site, and add a test that goes through that path (a command, the core loop, or the HTTP handler), not only the unit.
2. If it does not serve a kept feature, or a second implementation of the same concept already runs, delete it and its tests. One
   implementation per concept: when two exist, keep the one the live path uses unless the other is the plan's design and the live one
   is a stub, and say which you kept and why.
3. Then shrink what stays in your area: duplicated helpers become one, an interface with one implementation and no test fake becomes
   the concrete type, options nobody sets go, comments that restate the code go. Behaviour on reachable paths does not change: the
   existing tests are the contract, and you delete a test only together with the code it tests.

Kept features (the plan): issue thread as the only state (markers), chatops and trust, PR body with no cost or model (#210), reconcile
loop (Symphony 7/8), pick and area locks, plan to ticket DAG, workflow graph engine with per-node agent and tier, dispatchers routines,
fire and local, merge queue, gitx lease refs, trackers github/linear/jira, meter and spend ledger (tokenomics), packs and lock, eval,
store as a rebuildable cache, api Control and events, tui, mcp, dashboard, first-run, config layering, provenance, serve, a2a, sandbox,
tutor tiers, browser check pack, self-update and GitHub App auth.

Measure before and after: `git ls-files '*.go' | grep -v _test.go | grep -v '^src/' | xargs cat | wc -l` and the deadcode count for your
packages. Both go in the report.

## Lessons from earlier waves

- `just` is not installed in the cloud image; run the recipe bodies (see Setup). Gate formatting with `test -z "$(gofmt -l .)"`.
- Long checks can pass a 120 s tool timeout: run them in the background, write output to a file, and wait for it.
- If a new test passes first time, break the code once to prove it bites, revert, and say so.

## Setup

1. `git fetch origin && git checkout -b go/k3f-surface origin/next`.
2. `go version`. `next` needs Go 1.26; if yours is older, run `export GOTOOLCHAIN=auto` and every go command fetches the right one.
3. `just --version`. If `just` is missing, run the recipe bodies in `justfile` by hand: `gofmt -l .`, `go vet ./...`, `GOTOOLCHAIN=go1.26.7 go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2 run ./...`, `go test -race ./...`, `CGO_ENABLED=0 go build ./cmd/factory`. Say so in the report. Chain gate and push with `&&`, never `;`. Use `git fetch -q`.
4. Read `AGENTS.md`, `internal/api/api.go` and `internal/api/porttest/fakes.go` before writing code.
5. The Symphony spec, our scheduler contract, is on the brief branch: `git show origin/cloud-briefs:symphony-spec.md > /tmp/symphony-spec.md`. Cite its section numbers in test names or comments. Other KaaS repos may not be clonable from here; when a ticket names one you cannot reach, use the shapes the ticket gives and say so in the report.

The TypeScript tree (`src/`, `tests/`, `dashboard/`, `scripts/`) is the frozen v8 factory at tag `ts-final`. Read it to port behaviour and formats; never edit it.

## Your area

`internal/serve/`, `internal/a2a/`, `internal/browsercheck/`, `pkg/sandbox/`, `internal/selfupdate/`, `internal/githubauth/`, `internal/upgrade/`, `internal/dispatch/local/` (only the sandbox wrap), `internal/config/` (only new keys), new files under `cmd/factory/`, and the `addCommands`/`mountClients` lines

You may also add a dependency to `go.mod`/`go.sum` when the ticket names it. Any other file is outside your area: if you truly need one, make the smallest edit and list it in the report.

Six sessions work on `next` at the same time, each in its own packages. Never edit `internal/api/` (if a port is wrong, define the narrow interface you need inside your package and describe the change you want under "API change requests"), `cmd/`, `justfile`, `AGENTS.md`, `.github/`, `.factory/`, `.claude/`, `.agents/`, `scripts/kaas/` or the TS tree.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. Port behaviour from the TS file named in the ticket and keep its wire formats byte for byte (markers, comment bodies, argv). A file copied from another repo starts with `// Ported from <repo>@<sha> <path>` and only from MIT or Apache-2.0 code; add its `## <repo>@<sha>` section to `THIRD_PARTY_NOTICES.md` (the provenance test fails otherwise).

Commit with `git commit -s`, one commit per acceptance group, and push after each: `git push -u origin go/k3f-surface`. Run `just fast` before every push and `just check` before the last one.

## Checkpoints, before every commit

1. Area: every changed file is in your area or listed under "Files outside my area".
2. Scope: the diff serves only an acceptance line below. No refactor of other packages, no extra feature.
3. Meaning: each acceptance line still means what it says. If it cannot be met, record it blocked; never weaken it.
4. Proof: you saw each new test fail before the code and pass after.
5. No network, real token or model call in any test. Fakes from `internal/api/porttest` or a local `httptest.Server` only.

## Rules

- Tests are table tests where a rule has branches; every branch of a decision function has a row.
- No `ANTHROPIC_*` or other provider key in code, tests or env. No model name, token count or cost in any PR body or customer-facing text.
- No global state, no `init()` side effects, no goroutine without a context that stops it.
- Exported names get one-line doc comments that say what the code does, nothing it does not.
- No em dashes in prose. Plain sentences.
- Do not comment on, label or close issues, and do not open a PR. Never force-push or push to `next` or `main`.
- No session URL, `claude.ai` link or `Claude-Session:` trailer in any commit or file.
- If one acceptance line is blocked, record why and continue with the next.

## When you finish

Write the report below to a file outside the repo, then push it to its own branch with these commands (the supervisor's log cuts long messages short, and a repo hook refuses writes under `.factory/`):

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/v9-k3f-surface"
```

Your final message is then that same report, exactly:

```
BRANCH: go/k3f-surface
HEAD: <full sha you pushed, checked with git ls-remote>
## Summary
<one or two sentences>
## Acceptance
- <line> -> <test name> -> done | blocked (why)
## API change requests
<each, or none>
## Files outside my area
<each, with why, or none>
## Gate evidence
<last lines of `just check`, verbatim>
## Learnings
<what cost time; what the factory's defaults should do instead. One line each.>
```
