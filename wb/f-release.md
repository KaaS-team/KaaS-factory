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
Your branch: `wb/f-release`. Ticket id for the report: `f-release`.

## Your area
.goreleaser.yaml, install.sh (new or moved from factory-install), .github/workflows/release.yml, docs/install.md, one test file under tools/ or cmd/factory.

## Ticket: release pipeline for v9.0.0
- goreleaser builds `factory` for darwin/linux amd64+arm64 with version, commit and date injected; `factory --version` prints them.
- The brew formula goes to `KaaS-team/homebrew-tap` as `Formula/factory.rb` (goreleaser `brews:` with a token from the `HOMEBREW_TAP_TOKEN` secret; do not add the secret, name it in the report).
- `install.sh`: POSIX sh, detects OS and arch, downloads the release tarball, verifies the sha256 from checksums.txt, installs to `~/.local/bin` or `$FACTORY_INSTALL_DIR`. Copy the shape of goreleaser's own `godownloader`-style scripts or `starship` install.sh.
- Every URL says `KaaS-team/factory`, not KaaS-factory.
Upstreams to read: goreleaser docs (`brews`, `checksum`, `ldflags`), `cli/cli` release workflow.
## Acceptance
- [ ] `goreleaser release --snapshot --clean` builds all 4 targets in CI (add the step to release.yml as a dry run on PRs that touch these files, or to `just check` if it runs under 60s).
- [ ] A test runs `install.sh` against a local fake release dir (file:// or a tiny http server) and checks the binary lands and the checksum mismatch case fails.
