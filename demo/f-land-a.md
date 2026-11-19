You are one of 20 cloud sessions preparing a live client demo of three KaaS products: **blueprint** (skills and rules for coding agents and software teams), **kaasbot** (24/7 AI teammates) and **factory** (the AI SDLC software factory). The demo starts in about 2 hours. CLI and MCP are the surfaces that matter; a web UI is out of scope.

## Hard limits
- **60 minutes.** At minute 50, stop new work, make what you have green, push and write the report. A smaller thing that works beats a bigger thing that half works.
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
Repo `KaaS-team/KaaS-factory`, branch from `origin/next` (Go v9; the TS tree `src/ tests/ dashboard/` is frozen, never edit it). Gate: `just check` (or `./gate.sh` without just; `export GOTOOLCHAIN=auto` if Go is older than 1.26). Read `AGENTS.md` and `internal/api/api.go` first.
Your branch: `land/demo-a`. Ticket id for the report: `f-land-a`.

## Your area
only the files these branches touch

## Ticket: land the first half of the unmerged `go/*` branches into a staging branch
Branch `land/demo-a` from `origin/next`. Merge each of these in order: `go/k10-catchup go/k3f-meter go/k3f-rest go/k3f-surface go/k4-core-dispatch go/k4-docs-truth go/k4-ee-mount go/k4-eval-matrix go/k4-firstrun-pr go/k4-mcp-parity go/k4-mergetree`.
For each: merge, resolve conflicts by keeping both behaviours, run `just fast`. If a branch's change is already on `next` (empty diff), skip it. If it breaks the gate and cannot be fixed in 10 minutes, `git merge --abort` it and list it as dropped with the failure.
No research step for this ticket.
## Acceptance
- [ ] `land/demo-a` passes `just check`.
- [ ] Report lists every branch: merged, already in next, or dropped with reason.
