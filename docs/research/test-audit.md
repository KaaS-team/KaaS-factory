# Test suite audit, KaaS-factory main (read-only, no test run)

Method: wc and grep over tests/, mutation JSON, AGENTS.md, Makefile. No timings exist
(reports/junit.xml is a 20-test leftover, untracked); "slow" is judged from spawn/git/serve use and
size. Test counts are declarations (`test(`/`it(`); `.each` rows are not expanded, which is why
the declared total is below the ~3,400 quoted. Git history is shallow (49 commits, all
2026-10-31 and 2026-11-01), so file-added dates carry no information. I could not date files.

## 1. Size

- tests/*.test.ts: 298 files, 39,940 lines, 2,225 declared tests.
- Nested: tests/ported (24 files, 131 tests, 1,964 lines, ported from owainlewis/machinist and
  others), ee/tests (6 files). bun test picks these up too.
- By file length: under 50 lines 61 files, 50-149 156 files, 150-399 68 files, 400+ 13 files.
- 95 files hold 3 tests or fewer.

Top 25 by lines (tests): scenarios 1538 (82), dashboard-routes 928 (36), runtimes 858 (46),
workflow 830 (41), multi-repo 714 (21), agents 640 (35), doctor 637 (45), mutate 531 (29),
backup 477 (22), guard-hook 464 (28), receipt 451 (25), blobs 432 (14), config 412 (27),
acceptance-table 394 (22), executor 391 (12), plane-access 378 (21), install 358 (23),
git 351 (21), reset 345 (16), events 341 (18), dashboard-ui 318 (8), minion 301 (14),
context-pack 299 (19), skills 295 (24), github-app 282 (13).

Slow-looking (process, git or server use): git.test.ts (39 spawn/git hits), proof (14),
runtimes (12), skills (7), deploy (7), stack (6), lease (6), release, relay, adapters,
guard-hook (shell hooks), temp-leak, qa, mutate. These 10 to 15 files are the likely seconds.
Measure with `bun test --reporter=junit` once, nothing here does.

## 2. Tests that pin implementation, not behaviour

Counts are files and declared tests in the file (a test is counted once per category file, so
categories overlap):

| Category | Files | Tests |
|---|---|---|
| Reads src/*.ts as text and regex/toContain it (help.test.ts matches `case "serve":` in cli.ts) | 13 | 93 |
| Reads template, skills, hooks, shell, yml, Dockerfile, CI as text | 30 | 354 |
| Reads docs or *.md as text (readme-accuracy, docs-*, help, agents-registry) | 29 | 399 |
| Walks the repo tree (readdirSync/Glob): structural by design | 50 | 510 |
| Tests about the test harness itself (mutations, ci-wiring, quarantine, check-*) | 12 | 87 |
| Pins an exact number of 10 or more (`toBe(NN)`, `toHaveLength(NN)`) | 50 | 634 |
| `toContain`/`toMatch` calls, whole suite | n/a | 1,102 calls |
| Snapshots | 0 | 0 |

Judgement: the template/skills/docs readers are mostly legitimate "coupled pair" checks that
AGENTS.md names (agents.test.ts pins Claude argv byte for byte, skills.test.ts pins
STAGE_GUIDANCE, agents-registry pins docs/agents.md against PRESETS). The brittle part is
the tail: literal-prose pins (agents 17 literal pins, harness-defaults 7), the 634 tests that
pin counts of lists (no-pinned-counts.test.ts already bans this for registries, and its own
scan only covers registry mentions), and wording checks in docs-adr, readme-accuracy,
visual-system, make-registry, test-layers (pins L0-L2 seconds 10/60/180 and workflow
timeouts by regex on ci.yml). 39 files cite an issue number (69 refs): tests written for one
session's ticket, not a lasting rule.

## 3. No mutation and no structural role

Mutations: 79 per-entry files in tests/mutations/ plus 989 entries in tests/mutations.json
(still read until scripts/split-mutations.ts runs), naming 261 distinct test paths (as
string tokens). 45 of 298 files are named by no mutation (4,025 lines, 269 tests).
Excluding walkers/structural checks, the candidates with logic-only roles:

routes (23), derive (18), reset (16), inbox (15), blockers (15), state (13), takeover (12),
dashboard (11), board (9), cli-output (8), verify-agent (8), team-load (7), learn (7),
learn-export (5), retro (4), provenance (5), pool (5), repath (5), api-client (4), setup (4),
qa (3), merge-worker (2), plan-guard-run (2), plan-batch (2), verify-skip (2), fixtures (2),
skills-dir (2), scm-boundary (2), team-loosening (3), make-registry (3), secret-scan (3).
These are real behaviour tests with no proof they bite: they are not scaffold by the file
alone, but none is protected by a mutation, so a deletion is not caught either.
Structural and fine unmutated: no-pinned-counts, agents-registry, docs-adr, protocol,
agent-dirs, help, visual-system, agents-catalog.
Heavy mutation concentration: guard-hook 52, scenarios 38, workflow 36, mutate 29,
multi-repo 26, blobs 23 entries. Files with many tests and few or no mutations (reset 16
tests, takeover 12, routes 23, derive 18) are the weakest.

## 4. Near-duplicate or splittable groups

Tests / lines per group that test one subject in several files:

- check-changed-mutants + changed-mutants: 7 tests, 100 lines (one subject, two files)
- pr-body + check-pr-body + pr-body-lint: 28 tests, 365 lines
- dashboard + dashboard-routes + dashboard-ui: 55 tests, 1,436 lines
- metrics + metrics-get + metrics-month: 11 tests, 290 lines
- mutation-list + mutation-select + mutate + check-mutation-anchors: 46 tests, 693 lines
- secret-scan + secret-scan-wiring: 7 tests; plan-guard + plan-guard-run: 5 tests
- learn + learn-export: 12 tests, 285 lines
- workflow + workflow-md + workflow-pages + workflow-edit-safety: 48 tests, 1,155 lines
- doctor + doctor-checks: 49 tests, 678 lines
- docs-adr + docs-check + docs-links + readme-accuracy: 10 tests, 122 lines (all one
  "docs match code" role)
- visual + visual-a11y + visual-system: 13 tests, 179 lines
- agents + agents-acp + agents-catalog + agents-registry + presets: 72 tests, 1,230 lines
- 8 merge-* files and 6 trackers-* files (the trackers-* checks are repeated per tracker;
  tests/ports/tracker.contract.ts is already a shared contract, so per-tracker copies of
  contract cases are the overlap to fold).
Not diffed line by line; these are candidate merges, not proven duplicates.

## 5. What exists to tag scaffold vs permanent

No "[permanent]" or session-scaffold marker exists anywhere in src/, docs/, scripts/,
tests/ or AGENTS.md (grep: only "scaffold" hits are the unrelated `factory harness scaffold`
command and tests/harness-scaffold.test.ts, tests/install.test.ts). What does exist:

- `@quarantine` tag (Makefile `test` excludes it with `-t '^(?!.*@quarantine)'`; `make
  quarantine` runs only them). tests/quarantine.json is `[]` and scripts/quarantine.ts +
  tests/quarantine.test.ts enforce an owner and an expiry (MAX_DAYS) per tagged test.
  Enforced, but it means "flaky, parked", not "temporary scaffold", and is empty.
- scripts/check-tests-only.ts (+ tests/check-tests-only.test.ts, `make fast`): flags a
  change that only touches tests, deletes a test, removes an assertion, adds a skip or
  loosens a matcher unless the PR body has `Test change reason:`. It stops weakening,
  which also means it blocks deleting scaffold tests without a reason line. It exempts
  tests/mutations/ and fixtures as data.
- tests/skip-count.test.ts (5 tests) tests src/skip-count.ts, a diff counter of
  skip/fixme/todo markers, not a tag.
- src/test-layers.ts: five time-budget layers L0 (10 s) to L4 (1800 s), pinned by
  tests/test-layers.test.ts against the workflow timeouts. It tiers by time, not by
  lifetime, and no test declares a layer.
- Mutation entries (`make check-mutations`, run in mutations.yml off the push verdict) are
  the only per-behaviour "this is load-bearing" signal: a test named in a mutation is
  provably permanent. AGENTS.md says each new check lands with a mutation file.
- tests/no-pinned-counts.test.ts bans length pins only against registries.
- Rule 0 in .claude/rules/kaas-engineering.md: a check must be wired into make check.

Gap: nothing says when a test may be deleted. A permanent test = named in a mutation, or
structural walker, or listed contract port. Everything else is unclassified.

## 6. Ranked cleanup actions (estimates, unmeasured)

1. Add a one-line header tag test list, then make it a gate. Cheapest: a new
   `tests/permanent.json` (or `// @permanent` header) that a structural test cross-checks
   against mutation files, so "permanent" = mutation-named or listed, and the 45
   unmutated files must be listed or carry `// @scaffold issue-N expires YYYY-MM-DD`
   (reuse scripts/quarantine.ts ledger and its expiry check). Saves 0 now; makes every
   later item deletable. Wire into `make fast`.
2. Triage the 39 issue-numbered files (grep `#[0-9]{2,4}`) against the mutation list;
   delete or fold those with no mutation and no walker. Expect 30 to 60 tests, 1 to 2 s.
3. Fold the docs-match-code set (docs-adr, docs-check, docs-links, readme-accuracy,
   make-registry, test-layers, no-pinned-counts) into one `docs-structure.test.ts` that
   walks once. Saves about 5 files, 10 tests of overhead, under 1 s; test-layers' regex
   pins on ci.yml minutes are the first to drop (3 tests).
4. Replace count pins with derived values in the 50 files that pin numbers of 10 or more
   (634 tests); start with tests/ports contracts and scenarios.test.ts. Not a deletion,
   saves breakage on parallel branches; 0 tests, 0 s. Extend no-pinned-counts to all
   `toHaveLength(\d{2,})`.
5. Merge same-subject splits: pr-body trio, changed-mutants pair, metrics trio,
   dashboard trio, secret-scan pair, plan-guard pair, learn pair. 12 to 15 files gone,
   0 to 10 tests deduped, about 0.5 s (fewer module loads and temp dirs).
6. Cut the per-tracker copies: trackers-asana/clickup/jira/linear/plane to run through
   tests/ports/tracker.contract.ts and keep only tracker-specific cases. Estimate 20 to 40
   tests, about 1 s.
7. Add mutations (not delete) for routes, derive, reset, inbox, blockers, state, takeover,
   dashboard (about 130 tests); any that cannot get a mutation are the scaffold deletion
   list. Net tests: -20 to -50 after the pass.
8. Time first: run `bun test --reporter=junit` once into reports/junit.xml and rank files;
   attack git.test.ts, proof, runtimes, deploy, stack, lease, skills (spawn/git heavy) for
   in-process fakes or the L3/L4 layer. Expected 10 to 40 percent of wall time; no test
   removed. Do this before items 2 and 5 to avoid guessing seconds.

Total plausible saving from 1 to 6: roughly 80 to 150 tests and 3 to 5 s out of the ~2,350
declared; the mutation gap in item 7 matters more than the count.
