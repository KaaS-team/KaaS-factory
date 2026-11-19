You are one of 9 cloud sessions in Wave B: making the KaaS-team suite stable and simple to read before its first stable releases (factory v9.0.0, kaasbot, blueprint and solutions v1.0.0). Three products: **blueprint** (skills and rules for coding agents and software teams), **kaasbot** (24/7 AI teammates) and **factory** (the AI SDLC software factory). CLI and MCP matter most; a web UI is out of scope.

## Hard limits
- **75 minutes.** At minute 65, stop new work, make what you have green, push and write the report. A smaller thing that works beats a bigger thing that half works.
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

## Repo and gate
Repo `KaaS-team/KaaS-factory` (Go), branch from `origin/next`. Gate: `just check`. Read `AGENTS.md` first.
Your branch: `wb/f-review`. Ticket id for the report: `f-review`.

## Your area
.factory/reports/f-review.md only. Read-only review of the code; no code changes.

## Ticket: fresh review of next before v9.0.0 (m3-review)
You have not seen this code before; that is the point. Review `next` for: correctness bugs, security (command or argument injection, path traversal, tokens in logs or output, unsafe exec), dead or duplicate code, and anything a new reader cannot follow. Start from `cmd/factory/main.go` and walk each command into `internal/`.
- Each finding: file:line, what breaks, a concrete failing input, severity (high/medium/low), and the test that would catch it.
- Only findings you are confident in; no style nits.
## Acceptance
- [ ] Report lists findings ranked by severity, each with file:line and a failing input.
- [ ] Report lists the five hardest-to-read places with a one-line simpler shape for each.
