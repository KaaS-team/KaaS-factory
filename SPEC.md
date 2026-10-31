<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E14 Packs, brand, org
Milestone: Phase 3 docs
Runner: operator

## Risk: low

## Why
The decisions behind the factory sit in issue threads and in people's heads, so a new team cannot learn why the resolution rules, the merge queue or the cloud launch work as they do. The owner wants architecture decision records and walkthroughs written down so others can learn from them.

## Today
- `docs/` holds guides; there is no `docs/adr/` or `docs/walkthroughs/`. Read `src/team/resolve.ts`, `src/team/schema.ts`, `src/merge-queue.ts`, `src/overlap.ts`, `src/engine/plan-reuse.ts`, `scripts/lint-planned.ts` and `docs/` before writing: every claim must match code you read.

## Change
### T1: five ADRs
Files: `docs/adr/0001-team-model.md`, `docs/adr/0002-resolution-rules.md`, `docs/adr/0003-serial-merge-queue.md`, `docs/adr/0004-planned-specs-and-stub-guard.md`, `docs/adr/0005-overlap-serialisation.md`, `docs/adr/README.md`
Model: haiku
1. One file per decision, each with the headings `Status`, `Context`, `Decision`, `Consequences`, `Alternatives considered`. Status is `accepted`. Keep each under 60 lines.
2. Content per file: 0001 the seven nouns (Org, Team, Source, Role, Workflow, Gate, Policy) and why teams are config; 0002 the four resolution rules (inherit; policy is a ceiling and the strictest wins; roles, workflows and routes replace by name unless locked; the config hash is stamped on every run); 0003 why one merge at a time per repo with a rebase and a re-gate; 0004 why a plan must pass the planned lint and a size floor before a run starts; 0005 why issues that plan the same files wait for each other.
3. `docs/adr/README.md` lists the five with one line each.

### T2: three walkthroughs
Files: `docs/walkthroughs/first-run.md`, `docs/walkthroughs/two-teams.md`, `docs/walkthroughs/merge-queue.md`, `docs/walkthroughs/README.md`
Model: haiku
Deps: T1
1. Each walkthrough is numbered steps a newcomer can follow with real commands from the CLI (read `src/help.ts` for the commands; run `bun src/cli.ts --help` and quote only what it prints). `first-run.md`: from an issue to a merged PR. `two-teams.md`: how two team files resolve differently and how `factory explain` shows which file set a key. `merge-queue.md`: what happens when two green PRs wait.
2. Link each walkthrough to the ADR it illustrates.

### T3: a check that the docs stay true
Files: `tests/docs-adr.test.ts`
Model: haiku
Deps: T2
1. A test that every ADR has the five headings, every file in `docs/adr/` is listed in its README, every relative link in `docs/adr/` and `docs/walkthroughs/` resolves to a file, and none of these files contains an em dash.

## Tests
- `tests/docs-adr.test.ts`: [permanent] headings, index, links and no em dashes.

## Mutation
none: documentation only; the test reads files and has no source under mutation.

## Acceptance
- AC-1: every ADR has the five headings and is indexed: checked by `make test FILES=tests/docs-adr.test.ts` (T3)
- AC-2: every relative link in the new docs resolves: checked by `make test FILES=tests/docs-adr.test.ts` (T3)
- AC-3: no em dash appears in the new docs: checked by `make test FILES=tests/docs-adr.test.ts` (T3)

## Non-goals
Do not touch .github/workflows. No new dependencies. No em dashes, no filler words, no competitor or product names, no prices. Say only what the code does. Nothing outside Files.

## Files
- `docs/adr/0001-team-model.md`
- `docs/adr/0002-resolution-rules.md`
- `docs/adr/0003-serial-merge-queue.md`
- `docs/adr/0004-planned-specs-and-stub-guard.md`
- `docs/adr/0005-overlap-serialisation.md`
- `docs/adr/README.md`
- `docs/walkthroughs/first-run.md`
- `docs/walkthroughs/two-teams.md`
- `docs/walkthroughs/merge-queue.md`
- `docs/walkthroughs/README.md`
- `tests/docs-adr.test.ts`

## How to ship
One PR from branch feat/adr-docs. Commits use `git commit -s`. Fill every section of .github/pull_request_template.md with real evidence. Run `python3.12 scripts/kaas/check-affected.py --run` before pushing. Never put a session link in a commit or PR.
