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
Your branch: `wb/f-cutover`. Ticket id for the report: `f-cutover`.

## Your area
Delete only: src/ tests/ dashboard/ scripts/ relay/ verify/ packages/ make/ Makefile package.json bun.lock bunfig.toml tsconfig.json biome.json goals.json ci/ quality-baseline.json and any other file only the TypeScript line uses. Edit: README.md, AGENTS.md, CLAUDE.md, CONTRIBUTING.md, .ratchet.json, docs/ (only lines that name a deleted path).

## Ticket: delete the frozen TypeScript line (m4-cutover)
The TypeScript factory is frozen at tag `ts-final`; the Go v9 core under cmd/, internal/, pkg/ replaces it. Remove the TS tree so a new reader sees one product.
- Before deleting a path, prove nothing Go uses it: `grep -rn '<path>' --include='*.go' --include=justfile --include='*.yml' --include='*.yaml' cmd internal pkg tools justfile .github .goreleaser.yaml`. A path a Go test or the justfile reads stays; list it in the report.
- README.md and AGENTS.md: rewrite to the Go product only. README opens with what the factory does and a 3-command quickstart (`factory doctor`, `factory first-run`, `factory board --replay docs/demo/fleet.ndjson`). AGENTS.md lists the gate (`just check`) and the package map. No doc longer than the code it covers.
- `.ratchet.json`: lower the baselines to the measured values (deleting lines lowers them) with a reason line.
## Acceptance
- [ ] `just check` passes with zero errors and zero warnings after the deletion.
- [ ] `git ls-files | grep -E '\.(ts|tsx|mjs)$'` prints nothing, or each remaining file is named in the report with the Go reader that needs it.
- [ ] Every path README.md and AGENTS.md name exists (write a Go test in tools/ or cmd/factory that walks the backticked paths in both files and fails on a missing one; this is the repo's new doc check).
