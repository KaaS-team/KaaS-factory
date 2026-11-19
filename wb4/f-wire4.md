You are one of about 30 cloud sessions finishing the KaaS-team suite. Three products: **blueprint** (skills and rules for coding agents), **kaasbot** (24/7 AI teammates) and **factory** (the AI SDLC software factory, Go, repo KaaS-team/factory). CLI and MCP matter most; a web UI is out of scope. Every session owns a different set of paths, chosen so no two pull requests touch the same file. Staying inside your area is the most important rule.

## Hard limits
- **70 minutes.** At minute 60, stop new work, make what you have green, push and write the report. A smaller thing that works beats a bigger thing that half works.
- Stay inside **Your area**. Another session owns everything else. If you must touch a file outside it, make the smallest edit and list it in the report.
- Never push to `main`, `next` or any branch but your own. Never edit `.github/workflows/` (cloud tokens cannot push it): put the needed change in the report.

## Research first (at most 12 minutes), then copy, don't invent
Before writing code, read the source of the upstreams named in your ticket (`git clone --depth 1`, or WebFetch the raw files) and note the behaviour you will copy: command names, flags, output shape, tool names. Popular, proven shapes beat new ones. Copy code only from MIT or Apache-2.0 sources, with a `Ported from <repo>@<sha> <path>` header and a `THIRD_PARTY_NOTICES.md` entry. AGPL, non-commercial and unlicensed repos are ideas only. Name every upstream you used in the report.

## How to work
- For each acceptance line: write the test, watch it fail, write the code, watch it pass.
- No network, real token or model call in any test; fakes and `httptest` only.
- No provider API key anywhere. No model name, token count or cost in any customer-facing text (README, demo docs, PR body).
- Plain English in docs and output: short sentences, no em dashes, no filler.
- Commit with `git commit -s`. Push after each green step: `git push -u origin <your branch>`. Run the repo's gate (named below) before the last push; it must pass with zero errors and zero warnings.

## Report (required)
Write `.factory/reports/<ticket>.md` on your branch and push it last:
1. **Demo commands:** the exact commands a presenter types, in order, with the real output you got (trimmed).
2. **Acceptance:** each line, done or blocked with the reason.
3. **Upstreams copied:** repo@sha and what you took.
4. **Files outside my area** and **workflow changes needed**, if any.

## Files nobody edits (the lander handles them)
- `.ratchet.json`, `dist/`, `CHANGELOG.md`, `cmd/factory/main.go`, `cmd/kaasbot/main.go` (unless your area names it).
- If the ratchet step of the gate fails only because the line count rose, that is the one allowed gate failure: put the measured numbers in the report and go on.
- A new command: export `NewCommand() *cobra.Command` from your package and write in the report the one line that registers it. Do not register it yourself.
## Repo and gate
Repo `KaaS-team/factory` (Go), branch from `origin/next` (it now holds the 13 merged wb4 branches). Gate: `just check`. Read `AGENTS.md` first.
Your branch: `wb/f-wire4`. Ticket id for the report: `f-wire4`. Open the draft PR against `next`.

## Your area (exclusive)
cmd/factory (all files, including main.go for this ticket), internal/serve, internal/budget, internal/oidc, pkg/sandbox (all subpackages), internal/smoke, internal/config, internal/dispatch, and `.ratchet.json` (lower only). **Not yours:** internal/core, internal/tracker, internal/mergeq (f-r-tracker is still working there) and docs/ except the generated `docs/cli-reference.md` (f-docs owns docs/; if both change that generated file, the lander regenerates it).

## Ticket: wire the wb4 features so a command reaches them
The wb4 sessions built features that no `factory` command calls yet. `go run golang.org/x/tools/cmd/deadcode@v0.38.0 ./...` lists them; `go run ./tools/ratchet` reports deadcode 339, and the baseline before wb4 was 311. Wire each one into the real command path so the product uses it; delete only what has no real use, and say why in the report.
- **OIDC sign-in:** `factory serve` uses `serve.AuthWrap` / `oidc.Middleware` when `FACTORY_OIDC_ISSUER` is set; the shared password stays the default. The MCP HTTP transport reuses the same middleware.
- **Remote sandbox:** `pkg/sandbox/remote` becomes a runtime picked from config (for example `sandbox.runtime: remote` plus its URL from env), next to the existing local runtimes, through `pkg/sandbox`'s existing selector.
- **Budget:** `budget.Configure` runs at start-up from config, and `budget.Allow` is checked in internal/dispatch before each agent call (not in internal/core); a run over budget stops with a clear message.
- **Smoke:** `smoke.FromEnv` / `smoke.Run` are reached from a `factory smoke` subcommand (or the existing doctor or smoke path if one exists) that reads `FACTORY_SMOKE_REPO`; with no repo set it explains what to set and exits 2.

Dead entries added by wb4 (file:line from deadcode):
```
internal/budget/allow.go:33:6: unreachable func: Configure
internal/budget/allow.go:42:6: unreachable func: Allow
internal/oidc/oidc.go:110:6: unreachable func: From
internal/oidc/oidc.go:117:6: unreachable func: Middleware
internal/oidc/oidc.go:143:6: unreachable func: deny
internal/oidc/oidc.go:36:16: unreachable func: Roles.Role
internal/oidc/oidc.go:66:6: unreachable func: New
internal/oidc/oidc.go:84:20: unreachable func: Verifier.Verify
internal/serve/auth.go:19:6: unreachable func: AuthWrap
internal/smoke/env.go:25:6: unreachable func: FromEnv
internal/smoke/run.go:222:6: unreachable func: cloneRepo
internal/smoke/run.go:232:6: unreachable func: newDispatcher
internal/smoke/run.go:263:6: unreachable func: newCore
internal/smoke/run.go:292:6: unreachable func: tickUntilDone
pkg/sandbox/remote.go:27:6: unreachable func: RunRemote
pkg/sandbox/remote/client.go:118:21: unreachable func: ExitError.Error
pkg/sandbox/remote/client.go:124:18: unreachable func: Client.Exec
pkg/sandbox/remote/client.go:164:18: unreachable func: Client.CopyIn
pkg/sandbox/remote/client.go:173:18: unreachable func: Client.CopyOut
pkg/sandbox/remote/client.go:186:18: unreachable func: Client.Destroy
pkg/sandbox/remote/client.go:44:6: unreachable func: New
pkg/sandbox/remote/client.go:56:6: unreachable func: FromEnv
pkg/sandbox/remote/client.go:67:18: unreachable func: Client.do
pkg/sandbox/remote/client.go:89:18: unreachable func: Client.Create
```

## Acceptance
- [ ] `go run ./tools/ratchet` shows deadcode 311 or lower; run `go run ./tools/ratchet --update` so `.ratchet.json` records the lower numbers.
- [ ] Each wiring has a test through the command (cobra `Execute` or `httptest`): serve rejects a bad OIDC token with 401 when an issuer is set and keeps password auth when not; config `runtime: remote` selects the remote sandbox (fake server); a run over budget stops before the model stage; `factory smoke` with no repo exits 2 with the hint.
- [ ] Each new test fails with its wiring line removed; name the line in the report.
- [ ] `docs/cli-reference.md` regenerated (`UPDATE_GOLDEN=1 go test ./cmd/factory`) if commands or flags changed.
- [ ] `just check` passes with zero errors and zero warnings.
