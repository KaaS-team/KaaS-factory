# Factory v9: a thin, proven assembler for company software-delivery pipelines

This is the v7 plan, kept and deepened: the audit, cut list, OSS matrix, Go layout, dispatch, CLI/TUI/MCP, gate and cutover are all still here. New in this version:
- the pack/lock model;
- tokenomics and proof;
- tiers by company size;
- deep research on auditor, blueprint and playbooks, plus the first-hour wow;
- waves start at 6 sessions.

## Context

The factory (`KaaS-team/KaaS-factory`, Bun/TS, v6.3.0) has 41.5K lines of src, but only 10-12K of them serve the
real loop (issue → plan → build → verify → PR). It also copies other people's skills into itself
(blueprint ports mattpocock, addyosmani, gstack and others), so every upstream improvement means a manual re-port.

Param wants something else: **a small core that pulls the best open source to do the job, rather than a huge codebase to maintain.**
- It assembles skills, agents, workflows and checks by reference from high-quality upstreams.
- It keeps improving by evaluating newer upstream versions.
- It runs any workflow with any coding agent (or a custom agent) headless, on cloud sessions.
- It is **proven**: every claim is backed by eval runs.
- It has **tokenomics**: every run has a budget, a meter and a cost per merged PR.
- It serves a solo dev up to an enterprise, and leaves room for a business UI later.
- Language: Go first, with `just`. Rename to `KaaS-team/factory`.
- Execution: start at **6 RemoteTrigger cloud sessions**, then scale up by measured speed.

## 1. What we have today (audit done 2026-11-12)

### Repos: reuse, don't restart
| Repo | Today | Verdict |
|---|---|---|
| KaaS-factory (TS) | the loop, plus never-called orchestrator code (`src/orchestrate/pick.ts`, `groom.ts`, `src/intent/pipeline.ts`, `src/merge-queue.ts`, `src/adapters/git-lease`, `src/cloud/port.ts`) | **port the 10-12K core to Go** with its formats unchanged; cut the rest (table below) |
| blueprint | see 1a | becomes the **catalogue**: `upstreams.json` is already a lockfile, so it is generalised into `factory.lock` |
| factory-config | team/org YAML (ADR 0001/0002: policy is a ceiling) | **keep the format**; Go reads it through layered koanf |
| factory-mcp | MCP tool list | the tool names carry over to `factory mcp` (Go SDK) |
| auditor (Rust) | see 1a | **stays Rust**, as the deterministic evidence engine behind the first-hour wow |
| lean | repo slimming | a check pack |
| playbooks | see 1a | acceptance specs, conformance suite and the sales/demo material |
| factory-install, homebrew-tap | install script, brew | goreleaser publishes into them |
| factory-plugins | Claude Code plugin | ships the `factory-cloud-worker` skill |
| factory-enterprise, ee/ | SSO/SAML/SCIM | kept behind `//go:build ee` |
| factory-plane, figures, .github | board idea, assets, org CI | factory-plane gives ideas only; .github holds the reusable CI |
| brain | `claude -p` wrapper under Param's login | its argv and retry pattern is the `local` dispatcher |

### What in KaaS-factory earns its place (port to Go, formats unchanged)
- **State:** the issue thread is the only state (`src/derive.ts`, `src/rehydrate.ts`, `<!-- factory:data -->` markers).
- **Stage contract:** `stageSchema` (`src/schemas.ts`), `src/artifacts.ts`, and the gates line `FACTORY_GATES:` (`src/gates.ts`).
- **Trust and chatops:** `src/trust.ts`, `src/chatops.ts` (`/factory approve|revise|retry|cancel`), `src/labels.ts`, `src/blockers.ts`.
- **Claude argv:** `src/agents/presets/claude.ts` (stream-json, dontAsk, per-stage tools, budget). The other 7 presets (`docs/agents.md`) become YAML packs.
- **Orchestrator logic written but never wired:**
  - `src/orchestrate/pick.ts` (rankReady, planRefill)
  - `groom.ts` (planned body v1)
  - `src/intent/pipeline.ts` (spec → ticket DAG, cycle and duplicate checks)
  - `src/area-locks.ts`
  - `src/merge-queue.ts` (ADR 0003)
  - `src/adapters/git-lease`
  - `src/cloud/port.ts`
- **`template/`** (stage skills and hooks, markdown + bash) is what ships into customer repos. It stays, and it takes blueprint skills through the lock (BP8).
- **`tests/fixtures/`** (agents, trackers, stacks go/bun/uv/rails, team, splitbill) become the eval fixtures.

### 1a. The three repos that create the first-hour wow (deep research, 2026-11-12)

**auditor** (Rust, about 9.7K lines plus 2.9K test lines, mutation-tested, no release, private)
- **Today:**
  - `audit`, `report --format md|html` (A4, KaaS brand), `reaudit` (New/Resolved/Regressed delta), `export` (issue drafts as JSONL with `<!-- auditor:finding id -->`) and `learn` (reads factory history, read-only).
  - 43 rules, hard-coded in Rust. No LLM and no keys. It runs in seconds.
  - `plan` and `apply` exit 2.
- **Why there's no wow yet:**
  - It reads like a linter: about 15 one-line FAIL/WARN items, generic (LICENSE, CODEOWNERS), not ranked by impact.
  - The risk areas (auth, payments) are detected but never shown.
  - The PR and process lenses need hand-made JSON exports.
  - **Bug:** an empty lens scores 100, which inflates the overall score.
  - Nothing says "what the factory would do": no effort, tokens, before/after score or fix PR.
- **Licence:** contradictory. `LICENSE` is Apache, but `Cargo.toml` is Proprietary, and the NOTICE attribution is unfinished.
- **Open:** #2 E12.2 parity. Branch `cluster/auditor-v0.2-rules` is done and unmerged.

**blueprint** (much smaller than assumed; local checkout is 5 commits behind origin)
- **Skills:** 8. Seven are copied unchanged, each pinned in `upstreams.json` (repo, sha, from/to, sha256):
  - obra/superpowers: systematic-debugging, verification-before-completion
  - mattpocock/skills: domain-modeling, grilling, codebase-design, improve-codebase-architecture
  - addyosmani/agent-skills: code-review-and-quality

  The eighth, `plan-critic`, is KaaS-own (deterministic plan checks plus a rubric). It duplicates factory's `factory-plan-rubric`.
- **Pins are stale.** All three upstreams have moved; mattpocock's grilling changed.
- **Not yet merged:** the agents (verifier, gate-triage, complexity-surgeon) and 2 rules exist only on `cluster/blueprint-v0.2-skills`. 7 kit skills (repo-audit, impact-map, ship, intent, structural-test, add-dependency, debug-e2e) are mapped in `import-kit.mjs` but never imported.
- **Install:** plugin marketplace, or `node bin/kaas-blueprint.mjs` from a clone (`private: true`, so no npx). Nothing runs after install, so there's no first result.
- **Evals:**
  - `check-vendor`, `check-evals` and `check-routing` (TF-IDF, 90% top-1) run offline.
  - The real model eval (`nightly-evals.sh`) has never run.
  - Nothing compares a pin against upstream HEAD.
- **Duplication:**
  - The same pins also live in the private kit's `upstreams.json` (BP7).
  - The factory template should take blueprint through a lock (BP8).
  - Blueprint's own `.factory/` is a stale template copy (14 files drifted).

**playbooks** (123 files; no executable content)
- **Specs:**
  - 400-406: all merged in TS except **405 wiring, which never reached main**. A different `refill.ts` sits only on `release/v6.5.0`.
  - 500-510: 500, 503, 504 and 510 merged; 506 done in auditor; 501, 502, 505 and 507 open.
- **`research/symphony-spec.md`** (OpenAI Symphony) is the best scheduler contract we have:
  - §7 claim states and terminal reasons
  - §8.1 tick order
  - §8.4 backoff `min(10s·2^(n-1), 5m)`
  - §8.5 stall/terminal reconciliation
  - §9.5 workspace safety
  - §13.5 token accounting (absolute totals, deltas, no double count)
  - §14 restart from tracker plus filesystem
  - §17/§18 test matrix and conformance checklist
- **Sales material:**
  - `case-studies/hono*`, `fastapi*`: public-repo audits with gaps and 30/60/90.
  - `consulting/placement-by-size.md`: 6 size bands as the intake.
  - `consulting/rubric.md`, `lens-pr.md`, `lens-process.md`: metric formulas.
  - `research/git-workflow-packs.md`: 6 packs (solo, startup, scaleup, enterprise, regulated, oss).
- **`offerings/coverage.md` §3** lists 12 things sold with nothing built behind them. The waves below close the ones on the delivery path: `guard` spend ceiling, installable release, `auditor plan/apply`, `care` shadow mode.
- **Missing:** a first-hour run sheet, per-pipeline customer playbooks, a tokens-per-merged-PR definition, an eval scorecard schema and a lockfile schema.

### Issues (57 open on KaaS-factory, plus the satellites): 14 CARRY, 13 DONE-BY-REWRITE, 30 DROP
The CARRY issues become tickets:
- #125 + #3 spend ledger → **tokenomics** (W1-5)
- #210 PR footer with no model or cost → tracker-github (W1-4)
- #212 lessons PR → workflow pack
- #611 shadow mode → dispatcher dry-run (W2)
- #635 workflows staged in `ci/` because cloud tokens can't push `.github/workflows` → the local path
- #203, #392, #620, #636, #645 → W1/W2 tickets as noted
- #199, #275 → operator tasks
- #610, #643 → later
- #8 → blueprint
- #9 → ported
- E12.2 → auditor

### Overengineered or dead (cut, not ported)
| Cut | Size | Why |
|---|---|---|
| 55 test-only modules (intent wiring aside) | 4.5K | no CLI path reaches them |
| Signed in-toto receipts + `verify/` Rust | ~1.1K | no buyer asked; the PR plus the eval record is the receipt |
| Phone relay `relay/` Rust, QR encoder, ssh-control, remote-cli, runner-channel | ~1.1K | the TUI and dashboard replace them |
| 7 sandbox runtimes (agent37, microsandbox, codespaces, lwpr, http-sandbox, pool, wrap) | ~1.1K | runtimes are now dispatchers: routines, fire, local |
| Plane/ClickUp/Asana trackers, http-tracker | ~1K | GitHub, Linear and Jira stay |
| Minions, cron, event bus, epics, triggers in `watch.ts` | ~1.1K | the reconcile tick replaces them |
| Egress proxy, healer, promotion, tamper, clean-room, visual QA | ~1.2K | speculative guards; useful ones return as check packs |
| Mutation suite (989 + 230 entries anchored on source text) | 222KB | blocks refactors (`cli.ts:5` keeps a dead import only as an anchor) |
| `quality-baseline.json` exempting the 12 largest files | n/a | the cap never binds where it matters |
| `goals.json`, metrics/flake/selector scripts, the unread settings registry, `ci/` copy drifting from `.github/` | ~4K | process artefacts as code |
| `dashboard/plane/` (roles, devices, runners, push) | ~2K | read-only board only; ee/ keeps SSO |
| 111-field config over 787 lines | n/a | replaced by about 25 keys plus packs |

### Where we lack
1. **No cloud launcher.**
   - Today's routines are launched by hand from a Claude Code session (20 v6.4-v8.0 routines on 2026-11-05, all succeeded, briefs on `cloud-briefs`).
   - `claudeCloudProvider` (`src/cloud/claude.ts`) is a stub that always fails.
2. **No refill loop.** `cloudAware` would block a local worker for 90 minutes per session, and spec 405's wiring never reached main.
3. **No goal → ticket entry point.** Tickets carry no `Files:`, so overlap checks have nothing to read.
4. **Merge queue does one PR per poll,** under a single-host `DirLease`. A wave of PRs would stall it.
5. **Config can't be set up by a new team:** 111 fields, plus a second registry nobody reads.
6. **Speed:**
   - The CLI imports the dashboard on every command (`src/cli.ts:34`).
   - The gate needs cargo and uvx.
   - The ledger is a JSON blob with no locking.
7. **No tokenomics:** spend is "unknown" for the Claude cloud adapter, and there is no tokens-per-merged-PR measure.
8. **No proof:** no eval scorecard, and the blueprint model evals never ran.
9. **No first-hour result for a new company** (see 1a).

Branch state: `release/v8.0.0` (577 commits) has diverged from `main` (571), and about 30 stale `factory/issue-*` and `ship*` branches remain. They are tagged and frozen, not ported.

### OSS we draw from (star list `Param-Harrison/lists/factory` + topic `software-factory`)
**Rule for resale:**
- Reference by pin (packs) by default. Copy code only from MIT or Apache-2.0, with a `Ported from <repo>@<sha> <path>` header.
- `internal/provenance` keeps `THIRD_PARTY_NOTICES.md` matched to the headers and the lock.
- Core is Apache-2.0, `ee/` is `LicenseRef-KaaS-EE`, the brand is `LicenseRef-KaaS-Brand`.
- AGPL, CC-BY-SA, NOASSERTION and no-licence repos are ideas only.

| Upstream | Licence, lang | Already used | How the factory uses it |
|---|---|---|---|
| owainlewis/machinist | MIT, **Go** | 19 files ported to TS | **copy the Go files:** runner (process-group kill, event budget, usage parsing), protocol, `githubauth` (GitHub App), `triggers` (missed cron runs merged into one), `updater`, merge-policy refusal reasons |
| owainlewis/neo | MIT, Go | no | TUI patterns: visible plan, worker panes, tool activity |
| mitkox/esf | MIT, Go | no | patch and evidence record per run; per-repo harness config |
| github/gh-aw | MIT, Go | no | workflows as markdown with YAML frontmatter; "safe outputs" (the agent is read-only, the harness writes to GitHub) |
| makifbaysal/tasktrooper | Apache, Go | no | agent CLI adapters (Claude Code, Cursor, OpenCode) as preset data; a board-column owner picks up work |
| Agent-Field/SWE-AF | Apache, Go | no | planner: adaptive DAG, replan on failure |
| runkora/kora | Apache, Go | no | ee/: policy check before each action, identity per agent, scoped credentials |
| the-open-engine/zeroshot | MIT, Rust | no | workflow graph shape; the author never grades its own work (fresh-session verify) |
| the-open-engine/opcore | check licence in Phase 0 | no | per-edit check plugged in as a check pack (by pin, not copied) |
| OpenAI Symphony spec (`playbooks/research/symphony-spec.md`) | spec | researched | scheduler contract and the §17/§18 conformance suite; `WORKFLOW.md` format; token accounting |
| obra/superpowers, mattpocock/skills, addyosmani/agent-skills | MIT | copied in blueprint | **pinned references** in the catalogue; upgraded by eval |
| rudderlabs/devbox | MIT, TS | no | Linear/Jira intake; a PR comment pushes a fix to the same branch; no real secrets in the sandbox |
| open-inspect/background-agents | MIT, TS | no | Slack, webhook and Linear entry points; PRs attributed to the person who asked |
| os-factory/har | Apache, TS | no | MCP tool shape for a harness |
| addyosmani/factory, tobihagemann/turbo, iusztinpaul/squid | MIT, MIT, Apache | no | catalogue entries: policy, queue and evidence files; grill, then one plan approval |
| owainlewis/assembler, skills, agent-skills; mastra (mastracode only) | MIT / Apache | ported | display, run logs, agent dirs, headless flags |
| superplanehq/superplane, lemma, cortexapps/engrams | NOASSERTION / AGPL | no | **ideas only, never copied** (board columns Backlog, Implement, Verify, Done) |

## 2. Design: thin core plus packs pulled by reference

### Core (Go, one static binary, target ≤ 8K lines excluding tests)
`reconcile` (a pure `Decide()` plus a loop), `pick` (rank, area locks, refill), `plan` (goal → ticket DAG), `graph` (workflow engine),
`dispatch/{routines,fire,local}`, `mergeq` (batched, speculative, bisecting), `gitx` (merge-tree, lease refs),
`tracker/{github,linear,jira}`, `meter` (tokenomics), `packs` (resolver plus lock), `eval`, `store` (sqlite cache),
`api` (one versioned control API plus an NDJSON event stream). The CLI, TUI, MCP and dashboard are thin clients of `api`.
GitHub and the lease refs are the truth. A session is done when it pushes `factory/<t>-a<n>` plus `.factory/reports/<t>.md` and opens a PR.

### Decisions copied from the research
- **Level-triggered reconcile, as Kubernetes does.**
  - GitHub and the lease refs are the truth; SQLite is a cache that can be rebuilt.
  - One loop runs on a 30 s tick, in Symphony §8.1 order. No goroutine waits on a session.
- **Fire and forget.** The completion signal is the pushed branch plus the report plus the PR, not the session status.
- **Overlap is caught before dispatch.** Each ticket declares `Files:`. Area locks and a `git merge-tree` pre-check stop two sessions taking the same ground.
- **Batched speculative merge queue,** as in bors, Mergify and GitHub MQ.
  - Main stays green.
  - A failing batch is bisected, and the culprit gets a steer with the gate log.
- **Stall detector.**
  - No push within `stall_after` gets one steer.
  - Still nothing after twice that means a retry with Symphony §8.4 backoff.
  - After that, `needs-human` with the session URL.
- **Plan approval gate,** as in Jules and squid: `factory plan` shows the DAG and a human approves it once.

### Cloud dispatch (RemoteTrigger routines)
`Dispatcher` interface: `Dispatch(brief)`, `Steer`, `Cancel`, `Caps()`. There are three adapters:
1. **`routines`:** create + run through `/v1/code/triggers`, watched through `/v1/code/sessions` (list_runs, get_run_log).
   - This is how the 20 routines on 2026-11-05 ran.
   - Briefs live on `cloud-briefs`. The prompt is "git show origin/cloud-briefs:<name>.md, follow it exactly".
2. **`routines-fire`:** the documented `POST /v1/claude_code/routines/{id}/fire` with a per-routine token and `{text}` = brief name.
   - Limits: 30 fires per hour per routine, 100 per account.
   - One saved `factory-worker` routine is enough.
3. **`local`:** `claude -p` in a worktree under the person's own login.
   - It is the fallback, and it also handles `.github/workflows/**`, which cloud tokens cannot push (#635).
   - Its argv comes from the brain wrapper and `claude.ts`.

Other agents (codex, gemini, opencode, cursor, pi, acp, a custom CLI) run through `local` (or a self-hosted runner) using their YAML preset.

### Layout
```
cmd/factory/                      cobra root
internal/api                      versioned control API + NDJSON events (CLI, TUI, MCP, dashboard, future UI all use it)
internal/config                   koanf: builtin < org < team < repo < FACTORY_* < flags; `config explain`
internal/plan, plan/intent        planned-body v1, ticket DAG, waves, Problems(); goal -> spec -> tickets
internal/pick                     rank, area locks, refill, fire budget
internal/reconcile                Decide() pure + Run() loop (Symphony §7/§8)
internal/graph                    workflow graph engine (zeroshot shape, reads existing yml/md + WORKFLOW.md)
internal/packs                    resolver, factory.lock, licence check, cache, upgrade
internal/meter                    token accounting, budgets, spend ledger, report
internal/eval                     fixtures matrix -> scorecard
internal/firstrun                 auditor wrapper + factory-would-fix layer
internal/mergeq                   batched speculative queue (extends src/merge-queue.ts, ADR 0003)
internal/gitx                     merge-tree, diff names, ff push, lease refs (port of src/adapters/git-lease)
internal/gate                     gates.sh + FACTORY_GATES parser (src/gates.ts)
internal/observe                  GitHub -> observation per ticket
internal/tracker/{github,linear,jira}   github holds markers (src/derive.ts), trust, chatops
internal/dispatch/{routines,fire,local,brief}
internal/runner                   copied from machinist internal/runner (Go, MIT)
internal/store                    modernc sqlite (CGO_ENABLED=0)
internal/{tui,mcp,dashboard}      clients of internal/api only
internal/provenance               notices vs headers vs lock test
ee/                               //go:build ee: SSO/SAML/SCIM, policy (kora ideas)
template/                         kept; takes blueprint skills through the lock; adds factory-cloud-worker skill + report contract
```
Libraries, pinned with `go list -m -versions` in the skeleton:
- charm.land bubbletea, lipgloss, huh and bubbles v2
- cobra v1.10.2
- koanf v2.3.6
- go-github
- modelcontextprotocol/go-sdk v1.8.0
- modernc.org/sqlite

### Packs: assemble, don't copy
- **`factory.lock`** pins each source: `repo@sha#path`, with its licence, a hash and an eval score.
- **`factory add mattpocock/skills#tdd`** (also `addyosmani/agent-skills#…` and similar) resolves the source, checks the licence (MIT or Apache only, otherwise refused), fetches it into `.factory/cache` (gitignored) and writes the lock.
- **Pack kinds:**
  - **skill**: `SKILL.md`
  - **agent preset**: YAML holding argv, stream parser, model tiers, tools. claude, codex, gemini, opencode, cursor, pi and acp are data, not code. A custom agent is just another YAML.
  - **workflow**: a graph (next)
  - **check**: a command that writes a `FACTORY_GATES:` line. auditor, lean and opcore's per-edit check plug in here.
- **Catalogue** = blueprint, rewritten as a list of curated references with tags and scores. A company picks from it, and nothing is vendored.
- **Upgrade loop** (`factory packs upgrade`, nightly routine):
  1. Find newer upstream SHAs.
  2. Run `factory eval` on the golden fixtures with old and new versions.
  3. Open a PR bumping the lock only if the eval is not worse on pass rate and tokens per merged PR.

  This loop is the "continuously improve from high-quality sources" part.

### Workflows: any pipeline, any agent
- A zeroshot-style graph in `.factory/workflows/*.yml|md`: nodes are `agent`, `check`, `human` or `fanout`; edges are `pass`, `fail` and `revise`.
- It reads the 18 existing workflows (`docs/workflows.md` keys uses/next/reject/revise/run/runtime) unchanged.
- **Rule copied from zeroshot:** verify always runs in a fresh session, so the author never grades its own work.
- Shipped workflows: `issue-to-pr` (the default), `goal-to-tickets`, `bugfix`, `dep-upgrade`, `review-only`, `pack-upgrade`, `audit` (auditor).
- Each node can set its own `agent`, `model_tier` and `budget`.

### Tokenomics (`internal/meter`)
- **Meter.**
  - Parse usage from each agent's stream (stream-json usage events, ported from machinist's usage parsing) for local runs.
  - Read routine run logs for cloud runs.
  - Record tokens in and out, cache reads, wall time and attempts per node, ticket, workflow and team.
- **Budgets** live in config at three levels: per node, per ticket and per day per team (the org sets the ceiling).
  - At 80% a session gets a steer to wrap up.
  - At 100% it stops and goes to `needs-human`.
  - Local claude runs also pass `--max-budget-usd`.
  - The fire budget (30/h per routine, 100/h per account) is enforced in `pick`.
- **Ledger** is an issue comment `<!-- factory:spend v1 -->` per ticket (#125). Cloud routines need no shared DB, and sqlite caches it.
- **Unit economics** in `factory report`: tokens per merged PR, rework rate, human touches per PR, cycle time, and the cost of each workflow and pack.
- **Model routing:** small tier for plan, triage and docs; large for build and verify on high-risk areas. It is per-workflow data, tuned by eval.
- **Operator-only.** Spend never appears in PR bodies or customer views (#210, engineering rule). The dashboard shows it only with the operator role.
- No API key ever. Everything runs on the subscription login, and a test asserts the dispatch env has no `ANTHROPIC_*`.

### Proof (`internal/eval`)
- **Golden fixtures** reuse `tests/fixtures` (go, bun, uv, rails stacks, splitbill, team): each holds seeded tickets with hidden acceptance tests.
- **`factory eval --workflow X --agent Y --packs lock`** runs the matrix and writes a scorecard (JSON plus markdown):
  - pass rate on hidden tests
  - main stays green
  - tokens per merged PR
  - wall time
  - human touches
- The **nightly** eval runs as a routine, and the scorecard history is committed to `evals/`. It is the evidence for pack upgrades and for sales.
- **Dogfood proof:** the factory builds its own Wave 2 and Wave 3 tickets. KaaS repos (kaas, studio) run it in shadow mode first (#611), then live.
  Each run's NDJSON, session URLs and scorecard are kept.

### Config (layered: builtin → org → team → repo → env → flags; `factory config explain`)
About 25 keys in `.factory/factory.yaml`:
- repo, tracker, approval, dispatcher, slots (default 6), workflow
- agents, packs, budgets, merge_mode, stall_after
- …plus the factory-config YAML. `.factory/config.json` (as in products/kaas) is still read.

Unknown keys fail.

### CLI, TUI, MCP (Claude Code-grade UX)
- **Commands:**
  - `factory init`: a huh wizard that picks a tier preset from `git-workflow-packs.md`.
  - `first-run`.
  - `doctor`.
  - `plan "<goal>" | --epic #N`.
  - `run [--headless]`: headless prints NDJSON.
  - `status --json`.
  - `dispatch|steer|cancel|retry <t>`.
  - `queue`.
  - `logs <t> -f`.
  - `add <repo>#<path>`, `packs list|upgrade`.
  - `eval`.
  - `report`.
  - `config get|explain`.
  - `mcp` (stdio).
  - `dashboard` (read-only).
- **TUI screens:**
  - board: one card per slot (phase, elapsed, last push, stall flag, tokens vs budget); footer shows the fire budget;
  - DAG waves;
  - merge queue with live gate output;
  - ticket timeline;
  - plan review;
  - first-run report.

  Keys follow k9s and lazygit.
- **MCP tools** (factory-mcp names kept): plan, approve_plan, list_tickets, status, dispatch, steer, cancel, retry, queue, explain_config, first_run, report. Resources: `factory://board`, `factory://ticket/{id}`.

### Gate (replaces Make, the mutation suite and the line-cap baseline)
- **`justfile` `check`:** `gofmt -l`, `go vet`, golangci-lint, `go test -race ./...`, the provenance test, `CGO_ENABLED=0 go build`.
- **`just fast`:** only the changed packages.
- **CI** (`.github/workflows/ci.yml`) runs `just check` within the 3-minute PR budget. The eval and Symphony conformance run nightly.
- **Kept mutation check:** only for `reconcile.Decide`, `mergeq` and the tracker markers, as a small table test that flips each branch.

### The first-hour wow: `factory first-run` (the demo every company sees)
One command in their repo, under 60 minutes, and it **costs nothing until they say yes**:
1. **Audit (seconds, no model).** `auditor report --json` runs on the repo. `gh` pulls the last 90 days of PRs and git history so the PR and process lenses are real on the first run. The result:
   - a scorecard, with empty lenses marked "not measured";
   - a **top 3 risks** list built from the risk areas (auth, payments, migrations) with file:line evidence.
2. **The factory-would-fix layer (Go).** Each finding id maps to a catalogue pack (skill or workflow).
   - Each finding gets an effort size and an **estimated tokens and wall time**. Estimates start from `auditor learn` history and the eval scorecards, with a fixed prior until those exist.
   - Each finding gets a **projected after-score**.
   - Output: a one-page report (auditor HTML plus this layer). These operator estimates appear only in the report the company asked for, never in PRs.
3. **Plan.** `auditor export` drafts the 30/60/90 issues, now with `Files:` from evidence, a real acceptance line ("`auditor reaudit` lists `<id>` resolved") and the factory header. The company approves which ones get filed.
4. **One real PR.**
   - The factory picks the top low-risk, high-value finding.
   - It runs: plan-critic, then test-first build, then a fresh-session verify (verification-before-completion + code-review-and-quality), then the repo's gate.
   - It opens **one draft PR** with the audit as context.
   - `reaudit` shows the score move.
5. **Scorecard.** Actual tokens and time against the estimate, gates green, human touches = 0. This is the proof artefact the sales page links to.

**What the demo reuses:** the hono and fastapi case studies (playbooks) become the public demo runs, re-run nightly with `factory first-run --dry-run`, so the sales page always shows a fresh, real run.
**Packaging:** the same flow also ships as a blueprint `first-run` skill, so a Claude Code user gets it from the plugin marketplace before installing the Go binary.

## 3. Tiers by company size: have vs build

| Tier | Needs | Have today | Build |
|---|---|---|---|
| **Solo / 1 repo** | `brew install`, `factory init`, issue → PR, local or cloud | TS loop, local claude, template skills, brew tap | Go core, init wizard, `local` + `routines` dispatchers, default pack lock, `issue-to-pr` |
| **Team (2-20 devs, several repos)** | parallel sessions, merge queue, shared workflows, Slack, budgets | single-PR merge queue, team YAML, factory-mcp | refill to N slots, batched mergeq, team packs, meter + daily budget, Slack notify, TUI board |
| **Org (20-200)** | org ceiling, Linear/Jira, many runners, cost by team, pack catalogue | factory-config ceilings, Linear/Jira TS adapters | org layer + `config explain`, Linear/Jira Go, `factory report` by team, catalogue + upgrade loop, GitHub App auth |
| **Enterprise** | SSO/SCIM, policy before action, audit, self-hosted, own models | ee/ SSO/SAML/SCIM, factory-enterprise | ee policy check (kora ideas), audit export, `api` for a branded UI, self-hosted dispatcher (local runner pool), BYO agent presets |
| **KaaS service (us)** | automate a client's pipeline end to end | playbooks, auditor | client onboarding = `factory init --org` + catalogue picks + eval scorecard as the delivery report; UI on `api` later |

## 4. Execution: starting at 6 cloud sessions

**Phase 0 (me, local, about 1 h)**
1. **Tag and list branches.**
   - Tag `ts-final` on main and `ts-v8` on `release/v8.0.0`.
   - List the stale `factory/issue-*`/`ship*` branches and the merged or superseded ones to delete. I confirm with you before deleting.
   - Check opcore's licence.
2. **Skeleton.** In a `wt` worktree, put branch `next` off main with:
   - `go.mod` (`github.com/KaaS-team/factory`), `cmd/factory`, `internal/api` interfaces and `porttest` fakes;
   - `justfile`, `.golangci.yml`, `.github/workflows/ci.yml` (I push workflows; cloud tokens cannot);
   - `docs/oss-adoption.md` (the matrix above with pinned SHAs), a lean `AGENTS.md`, the `.factory/reports/` contract.
3. **Green gate.** Get `just check` green on the empty skeleton, then push it.
4. **Briefs.** Write 6 briefs to each repo's `cloud-briefs` (`v9-<ticket>.md`). They reuse the proven brief shape from 2026-11-05 (area, goal checklist, checkpoints, forbidden paths) and drop the TS-only rules. Each one:
   - checks the Go version (`GOTOOLCHAIN=auto` if it is too old);
   - branches `go/<ticket>` off `next`;
   - names its playbooks spec and source files;
   - lists its `go test` acceptance;
   - runs `just fast` before every push;
   - writes `.factory/reports/<ticket>.md`.

**Wave 1: 6 routines** (RemoteTrigger create: enabled false, no cron, env `env_01ECrMwvBUSejxWB9dKdyzQ1`; then run).
- **Mix:** two sessions make the wow (each in its own repo), and four build the core on `next`. They are disjoint by repo and by package.
- **Why this mix:** the wow ships first, through Claude Code plus the auditor, before the Go core exists.

| # | Repo | Ticket | Spec / source | Acceptance |
|---|---|---|---|---|
| 1 | auditor | **wow-audit** | merge `cluster/auditor-v0.2-rules` (#2); `score.rs`, `export.rs`, `profile.rs` | empty lens = "not measured" and is left out of overall; `--gh` fetch fills the PR and process lenses; top-3 risks from risk areas; export has `Files:` + acceptance + factory header; `--gates` prints `FACTORY_GATES:`; rule metadata (title, window, pack id, effort) in a data file; one licence value + NOTICE; goldens updated |
| 2 | blueprint | **wow-first-run + catalogue** | `upstreams.json`, `sync-upstream.mjs`, `import-kit.mjs`, plan-critic | merge `cluster/blueprint-v0.2-skills`; run the kit import; `first-run` skill (audit → pick one → plan-critic → test-first → verify → draft PR) with an eval on a fixture repo; `upgrade-pins` script compares pin vs HEAD on the evals and writes a bump PR only if not worse; `npx kaas-blueprint` works; stale `.factory/` re-synced; plan-critic is the one rubric (factory-plan-rubric points at it) |
| 3 | factory `next` | reconcile + pick | Symphony §7/§8/§14; spec 402, 405; `pick.ts`, `area-locks.ts` | Symphony §17 cases for tick order, claim states, backoff, stall; refill skips overlap; restart rebuilds from GitHub only |
| 4 | factory `next` | packs + lock + workflow graph | blueprint `upstreams.json` shape; Symphony §5 `WORKFLOW.md`; zeroshot | resolve `repo@sha#path` + sha256; AGPL/CC-BY-SA refused; all 18 existing workflows + blueprint pins load; unknown template var fails; verify node gets a fresh session |
| 5 | factory `next` | dispatch routines/fire/local + meter | spec 400, 401, 403; Symphony §13.5; `claude.ts` argv | create/run golden; same key gives the same session (idempotent); fire rate caps; token deltas never double-count; budget 80% steer / 100% stop; no `ANTHROPIC_*` |
| 6 | factory `next` | tracker-github + gitx | `derive.ts`, `trust.ts`, `chatops.ts`, `git-lease`, #210 | marker codec golden; untrusted comment ignored; PR footer has no cost; merge-tree conflict; lease CAS |

I watch with `list_runs` and `get_run_log`, and merge each branch into `next` with `just check` before every push.
**Scale rule:** if a wave's median session is ≤ 60 min and at least 5 of 6 pass first time, the next wave gets 9 sessions, then 12. Otherwise it stays at 6.

**Wave 2 (6-9 routines):**
- `factory first-run` in Go: wraps auditor, adds the factory-would-fix layer, and writes the scorecard
- mergeq (batched, bisecting; `merge-queue.ts`, ADR 0003; machinist merge-policy)
- store + observe + gate (sqlite cache rebuilt from empty; pushed-without-report counts as running; `FACTORY_GATES` parse, a missing line counts as a fail, a timeout kills the run)
- plan / goal → tickets (spec 404, `intent/pipeline.ts`)
- eval harness + fixtures
- config layering + factory-config read
- CLI + headless NDJSON + doctor
- TUI board
- MCP (factory-mcp tool names)
- upgrade loop
- Linear/Jira
- shadow mode (#611)

**Wave 3 (by speed):**
- dashboard on `api`
- ee SSO/SAML
- ee SCIM + policy (kora ideas)
- template `factory-cloud-worker` skill + report contract
- GitHub App auth + self-update (machinist githubauth/updater)
- release: goreleaser, install.sh, brew tap, `factory-install` repo
- e2e harness against a sandbox repo with a fake dispatcher
- generated docs: README, config reference, CLI reference
- gh-aw-style workflow frontmatter for custom stage lists
- per-pipeline customer playbooks as workflow packs: migration, framework upgrade, coverage ramp, onboarding/context files
- remaining CARRY tickets
- catalogue rewrite in blueprint (pins in place of copies, BP7/BP8)

**Phase 4: dogfood → cutover.**
1. **Dogfood.**
   - The factory runs Wave 3 on itself.
   - `factory plan` runs a real goal on a sandbox repo through to merged PRs.
   - The eval scorecard baseline is committed.
   - kaas runs in shadow mode, then live.
2. **Cutover on `next`.**
   - Delete the TS tree: src, tests, dashboard, scripts, relay, verify, packages, Makefile, make/, bun files, the mutation and quality baselines, `goals.json`, the `ci/` copy.
   - Merge `next` into main.
3. **Rename.** `gh repo rename factory`: **I confirm with you first**, as with branch deletions.
4. **Downstream.** Update the `.factory/factory.yaml` of products/kaas, blueprint and factory-install, then the routine sources.

## Verification
- `just check` is green on `next` after every merge. The table tests for `Decide`, mergeq bisect and the meter budget actions each get reverted once to watch them fail.
- `factory eval` on the fixtures produces a scorecard with pass rate, tokens per merged PR and main-green. Each pack upgrade PR carries its scorecard diff.
- End to end: `factory run --headless --slots 6` on a sandbox repo dispatches 6 routines, at least 5 land through the merge queue with main green, and `factory report` shows tokens per merged PR.
- `factory mcp` driven from Claude Code: list tickets, steer one.
- `factory init` runs on factory-install from a clean clone in under 2 minutes.
- The Symphony §18 conformance checklist passes in the nightly run.
- `factory add mattpocock/skills#<skill>` then `factory packs upgrade` opens a lock-bump PR only when the eval is not worse.
- **The wow, timed.** I run the blueprint `first-run` skill (Wave 1) and then `factory first-run` (Wave 2) on a fresh clone of hono and fastapi. Pass means:
  - the report has top-3 risks with file:line;
  - estimated vs actual tokens are both shown;
  - one draft PR has green gates;
  - `reaudit` shows the score move;
  - the whole run takes under 60 minutes.
- After auditor's empty-lens fix, the next-saas golden no longer shows "pr 100". I revert the fix once to watch that test fail.

## Risks
- **Subscription usage.** That is why it starts at 6 sessions, and the meter reports burn after Wave 1 before any scale-up.
- **`/v1/code/*` is undocumented.** The documented `fire` endpoint is the fallback; it needs one per-routine token from the web UI.
- **Upstream skills change or vanish.** Pins plus the cache keep runs reproducible, and an upgrade happens only when the eval passes.
- **Go version in the cloud environment.** Every brief checks it first; `GOTOOLCHAIN=auto` downloads one if needed.
- **Plugin marketplaces need files in the repo.** Blueprint keeps a generated, pinned build for marketplace installs; the Go binary materialises packs itself.
- **The blueprint model evals have never run, and `nightly-evals.sh` refuses CI and keys.** They run as a nightly routine under the subscription login, never with a key.
- **Outward actions** (rename, branch and TS deletion) only after the dogfood passes, each one confirmed.

## 5. The kaas.team suite: one factory per service line, fewest repos (discovery 2026-11-12)

### What discovery found
- **Sold with nothing built behind it.** The site sells 16 priced offers (`kaas.team/src/content/site.ts` PRICES, `solutions.ts`, `pages/*`). 10 have no code or playbook:
  - MCP gateway, AI red teaming, Text-to-SQL;
  - Executive Briefing, Applied Ops Masterclass;
  - LLM gateway and LLM observability (internal use only);
  - Enterprise AI search (only brain, a different shape);
  - the two non-engineering Audit tracks;
  - the Sustain monthly re-test.
- **playbooks maps a retired catalogue.** `offers.snapshot.json`, `map.md` and `coverage.md` still list the 16 old offers. Their source file (`offers.ts`) is gone.
- **Duplicates:**
  - 7 skills are byte-identical in blueprint and the kit, each with its own `upstreams.json`;
  - 3 copies of the factory-* skills;
  - 3 factory MCP servers, 3 dashboards, 3 install paths;
  - `products/kaas` runs its own factory loop;
  - the auditor overlaps the kit's `eng-audit-repo`.
- **Shells and stale repos:**
  - factory-plugins and factory-enterprise are empty;
  - homebrew-tap is still on TS v6.2.0;
  - factory-plane's README contradicts its code;
  - lean's own bench shows no saving;
  - lwp-studio and lwp-internal-apps are stale, with only Dependabot PRs.

### The rule for public vs private (from the research)
- **Open** what reveals a problem or shows how we think: the runtime, the skills format and catalogue, a free crude scorecard, and method write-ups.
- **Close** what fixes the problem at the quality we charge for: auditor weights and calibration, client recipes, solution eval sets, curricula.
- **Test:** if a reader could deliver the $12.5K Audit from our public repos alone, we opened too much.
- **Shape:** OpenHands and Coder keep `enterprise/` inside one repo. Sourcegraph and CKEditor show what too many repos cost a small team, and why they consolidated.

### Six factories, no new repo unless nothing existing fits
| Factory | Sells | Lives in | Reuses (not rebuilt) |
|---|---|---|---|
| **Build** | Claude Code rollout, the agent solutions | `factory` (public): workflows `issue-to-pr`, `goal-to-tickets` | agent CLIs as YAML presets; OpenHands/Aider via `local` |
| **Design** | UI work inside Transform | `blueprint` design pack + a factory `design-to-pr` workflow | Penpot MCP (MPL), shadcn/Storybook (MIT), Onlook (Apache) |
| **Deploy** | LLM gateway, MCP gateway, observability, search, Text-to-SQL | `solutions` (private): one kit per solution (OpenTofu + compose + eval + runbook) | LiteLLM, agentgateway/ContextForge, Langfuse, Onyx, WrenAI/Vanna, Docling, Kamal/Coolify |
| **Audit** | 10-day Audit (all 3 tracks), AI red teaming | `auditor` (private): add answer-wait and AI-tool/data tracks plus a red-team pack | OpenSSF Scorecard (Apache), Opengrep (not Semgrep rules: their licence bars competing use), promptfoo, garak |
| **Transform** | Legacy modernization, framework and dep upgrades | `factory` workflows (migration, framework-upgrade, dep-upgrade) + check packs | ast-grep, jscodeshift; OpenRewrite core only, licence checked per recipe |
| **Train** | Executive Briefing, Agentic SDLC and Applied Ops masterclasses | `playbooks/training` (private curricula) + studio films; labs run on `factory` and `blueprint` | Agent Skills standard |
| **Sustain** | Watch/Run/Scale | a factory `sustain-retest` workflow on a monthly routine: re-audit plus solution evals, writing the client report | auditor `reaudit` |

### Target repos
- **Public, 4 repos (trust):**
  - `factory`, renamed from KaaS-factory. It takes in the MCP, dashboard and install script, with `ee/` behind a build tag.
  - `blueprint`: the one skills catalogue, as pins. The kit consumes it by lock instead of copying.
  - `homebrew-tap`: brew needs this repo name.
  - `.github`.
- **Private, 5 repos:**
  - `auditor`.
  - `playbooks`.
  - `solutions`: `products/kaas` transferred to the org and renamed. It already holds triage, reconciler and docdesk. Its own factory loop is deleted, and the platform kits are added.
  - `factory-config`, ported to Go.
  - `figures`.
- The kit stays personal.
- **Archive (each confirmed first):**
  - factory-mcp, factory-plane, factory-plugins, factory-enterprise and factory-install, once their code is in `factory` or proven empty;
  - lean, once its settings profile moves into blueprint's rollout pack;
  - lwp-studio and lwp-internal-apps.

### Wave 5 (about 20 sessions; the factory stub wave runs alongside)
- **Factory stubs, 8 sessions (already planned):** observe.Source, mergeq CoreQueue, report.Source, logs lookup, plan Filer/Epic, shadow/trust config keys, template-v9, homebrew formula on the Go release.
- **Suite, 12 sessions:**
  - **S1 playbooks:** the catalogue is regenerated from `site.ts`/`solutions.ts`. A check fails when an offer has no delivery row.
  - **S2-S4 solutions:** LLM gateway, MCP gateway and observability kits. Each one deploys on compose and has an acceptance eval.
  - **S5-S6 solutions:** Text-to-SQL and enterprise search kits.
  - **S7 auditor:** company-wide tracks (answer waits, AI tool and data inventory) as lenses with goldens.
  - **S8 auditor:** red-team pack (promptfoo/garak runner, findings in `auditor.report/v1`).
  - **S9 playbooks/training:** Executive Briefing and Applied Ops curricula, written to the course-copy rules.
  - **S10 blueprint:** rollout pack (ship group, hooks, rules, lean's settings profile). Kit skills are replaced by a lock on blueprint.
  - **S11 factory:** `sustain-retest` and `design-to-pr` workflows plus their packs.
  - **S12 factory:** take in factory-install's `install.sh`, prove factory-plane and factory-mcp are superseded (feature parity list), and write the archive notes.
- **Acceptance:** every offer on the site has a delivery row in playbooks pointing to a repo path, and S1's check enforces it.

## 6. kaasbot: 24/7 AI teammates (private repo, research 2026-11-12)

### What it is, and the line with the factory
- **The factory** owns anything whose output is a merged change in a repo.
- **kaasbot** owns standing roles: ops, sales, support, research. Each role has wakeups, channels, memory and non-code outputs.
- When a teammate needs code changed, it files a `factory:ready` issue. It never edits code itself.
- **Repo:** `KaaS-team/kaasbot`, **private**. It is the delivery engine behind the company-wide solutions (§5, the `project_kaas_company_wide` direction).

### What the research found (12 repos read at source)
- **"grokbot"** is xAI's closed Grok Bot (2026-08-11): always-on bots, each with its own cloud computer. There is no source to copy.
- **"openbot"** is CopilotKit/OpenBot (MIT). Its policy gateway is the part worth porting.
- **The OpenClaw lineage** is the reference design (openclaw MIT TS, picoclaw MIT **Go**, zeroclaw/ironclaw/openfang Apache Rust, moltis MIT Rust, Codync Apache Rust, nanoclaw MIT TS). The shared shape:
  - a gateway and event bus;
  - cron that sleeps until the next job;
  - a 30-minute heartbeat that replies `HEARTBEAT_OK` when there is nothing to do;
  - MEMORY.md plus daily notes, with an SQLite FTS index;
  - SKILL.md skills the agent drafts itself;
  - the agent CLI (`claude -p`, codex, or ACP) owns the model loop.
- **Ideas only, never copied** (licence): goclaw (CC BY-NC), nightly-labs/openbot (PolyForm-NC), kwant (AGPL), gawkbot (no clear licence).
- **Don't copy:** picoclaw and openfang pass the skip-permissions flag to claude. ironclaw and hermes call the API with the OAuth token. kaasbot does neither.

### Language: Go
- It shares the factory's port shape: `Dispatcher`, the local and routines presets, `meter`, `packs`, `eval` and `provenance`.
- picoclaw is the best permissive Go source to copy.
- MCP (go-sdk v1.8.0) and A2A (a2a-go v2.8.0) have official Go SDKs. ACP has coder/acp-go-sdk (Apache).
- Go `internal/` cannot be imported across modules. So K1 has the factory export a small public `pkg/agentrun` (the Dispatcher port, local and routines dispatchers, meter), and kaasbot imports that rather than copying it.

### Modules
| Module | Does | Copied or ported from |
|---|---|---|
| `roster` | One YAML per teammate: role, CLI preset, channels, schedules, tool allow-list, daily budget. Pinned through the factory `packs` lock | n/a |
| `wake` | Slack (Socket Mode, no public ingress) and webhook events; cron sleeps until the next job. The heartbeat runs a **deterministic precheck** first (anything new since the cursor?), and the model runs only when something changed | picoclaw `pkg/cron`, `pkg/heartbeat` (MIT, copy) |
| `mailbox` | SQLite inbox per teammate, one turn at a time per thread, event-driven | nanoclaw mailbox (MIT, port) |
| `run` | `agentrun` Dispatcher with presets: `claude -p --output-format stream-json --resume <id> --allowedTools …`, ACP (claude-agent-acp, codex-acp), cloud routines | picoclaw `pkg/providers/cli` (copy) |
| `mcp` | kaasbot's own tools served to the CLI: remember, handoff, post, request_approval, file_factory_ticket | go-sdk |
| `gate` | CEL policy (deny wins, a missing rule denies) decided before every side-effecting tool call; an audit row is written for every decision | OpenBot `server/src/computer/gateway.ts`, `policy.ts` (MIT, port) |
| `memory` | MEMORY.md (character cap) plus daily notes in git, SQLite FTS5 index, deterministic compaction. No vector DB until FTS recall fails the eval | picoclaw `pkg/seahorse` (copy); moltis compaction idea |
| `learn` | After a finished task, a one-shot may propose **at most one** skill or memory edit as a draft PR. It is replayed against the teammate's eval cases and promoted only if no case gets worse and a human merges. Memory edits must cite a source message. Skills unused for 30 days are archived | openclaw skill-workshop drafts, Codync dream rules, hermes curator (port) |
| `triage` | One-shot small-model call with no tools classifies to ignore, reply, act or escalate. Only "act" starts a full session | picoclaw `pkg/routing/classifier.go`, Codync oneshot |

### Lean cost (no API key; the scarce resource is the subscription usage window)
- **Idle is free.** It runs on events only, plus heartbeats that pass the precheck.
- **Triage before acting.** The same session is resumed per thread, so the prompt cache is reused. The system prompt and roster stay a stable prefix.
- **Daily token budget** per teammate and per heartbeat through `meter`. Over budget, the teammate posts once and goes quiet.
- **Out of usage:** fall back to the next preset (if allowed), or defer to a cloud routine.

### Coordination and UI
- **Inside:** the mailbox plus a `handoff` tool. GitHub issues and Slack threads are the visible bus.
- **Outside:** an A2A agent card through a2a-go, in phase 2.
- **UI:** Slack Block Kit. AG-UI and A2UI are skipped for now (no Go SDK; nothing needs a generated UI yet).

### Defaults I chose (Param can overturn)
- First teammate: **ops/research**. It watches the GitHub org and inboxes, writes a daily digest to Slack and files factory tickets.
- Claude only. A Codex fallback is a roster switch, off by default.
- Param approves skill PRs.
- **Host:** an always-on box running the official CLI under the login, or cloud routines for scheduled wakeups. This is decided at K3. The laptop is not a 24/7 host.

### Risks
- **Subscription terms and weekly limits** for always-on use of one login. Stay on the official CLI or ACP only, meter everything, and confirm before running a 24/7 host.
- **Prompt injection** from inbound mail and Slack. The gate and per-role allow-lists are mandatory, and skip-permissions is never used.
- **ACP adapters pin SDK versions** and drift.

### Execution
- **K0 (me):**
  1. Create the private repo with a Go skeleton (go.mod, cobra, justfile, CI, AGENTS.md, THIRD_PARTY_NOTICES, provenance test), and get `just check` green.
  2. Write this section's research to brain as `research/kaasbot`.
- **K1 (cloud, about 6 sessions):** factory `pkg/agentrun` export; roster + config; wake (cron + heartbeat precheck); mailbox + triage; gate (CEL + audit); memory (FTS5 + compaction).
- **K2:** run presets (claude resume, ACP), mcp tools, Slack channel, learn loop with eval replay, the first teammate end to end in shadow mode.
- **K3:** host decision, live run for one week with the meter report, then the A2A card.
