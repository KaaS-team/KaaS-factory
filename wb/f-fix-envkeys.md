You are one of about 26 cloud sessions finishing the KaaS-team suite for its first stable releases (factory v9.0.0, kaasbot, blueprint, auditor, playbooks, solutions, factory-config v1.0.0). Three products: **blueprint** (skills and rules for coding agents and software teams), **kaasbot** (24/7 AI teammates) and **factory** (the AI SDLC software factory). CLI and MCP matter most; a web UI is out of scope. The factory repo will be renamed from KaaS-team/KaaS-factory to KaaS-team/factory; the Go module is already github.com/KaaS-team/factory.

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
Repo `KaaS-team/KaaS-factory` (Go), branch from `origin/next`. Gate: `just check`. Read `AGENTS.md` first if it exists.
Your branch: `wb/f-fix-envkeys`. Ticket id for the report: `f-fix-envkeys`.

## Your area
internal/config only.

## Ticket: H1: documented FACTORY_* env vars break every command
The finding comes from the fresh review in `.factory/reports/f-review.md` on branch `wb/f-review` (`git fetch origin wb/f-review && git show origin/wb/f-review:.factory/reports/f-review.md`). Read your finding there first.
- `internal/config/load.go` rejects unknown `FACTORY_*` keys, so setting `FACTORY_MCP_TOKEN`, `FACTORY_A2A_TOKEN`, `FACTORY_ALLOWED_HOSTS` or `FACTORY_ALLOWED_ORIGINS` makes every command fail with `env layer: unknown key`.
- Fix: the config env layer reads only keys the config schema knows and ignores the named runtime variables (an explicit allow list in one place, not a prefix hack).
## Acceptance
- [ ] A table test sets each of the four variables and `Load` succeeds.
- [ ] An unknown misspelled config key still fails with a clear message.
- [ ] Each new test fails with the fix reverted; say so in the report with the failing line.
