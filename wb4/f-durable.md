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
Repo `KaaS-team/factory` (Go), branch from `origin/next`. Gate: `just check`. Read `AGENTS.md` first if it exists.
Your branch: `wb/f-durable`. Ticket id for the report: `f-durable`.

## Your area (exclusive)
internal/reconcile (all subpackages).

## Ticket: runs resume after a crash (research gap 6)
- Copy the DBOS durable step idea (MIT): every reconcile side effect is a named step whose result is written to the existing event log before the next step runs.
- On start, `Tick` replays the event log and skips steps already recorded for the ticket, so a crash between push and PR open resumes at PR open and never pushes twice.
- Keep `Decide` pure. Split any function over 60 lines on the way.
## Acceptance
- [ ] Test: crash after push (the fake returns a crash), restart, exactly one PR opened and one push.
- [ ] Test: a fully recorded ticket does no side effect on restart.
- [ ] Each new test fails with the code reverted; say so with the failing line.
