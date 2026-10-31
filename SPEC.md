<!-- factory:planned v1 -->
Blocked by: #212
Deps: #225, #212
Epic: E10.2 Commit and QA quality
Milestone: Phase 10 self-improvement
Runner: factory

## Why
A factory PR should read like a careful engineer's: decisions written down when a boundary moves, the change exercised in a running app, and a reviewer able to compare the screen before and after without opening main. Today nothing checks that a boundary change carries a decision record (#67), nothing drives the running app (#65), a UI build keeps only the after shots in its run folder (#63), and nobody measures whether the factory is getting cheaper or more accurate run over run. This epic adds R7c (docs-touched check), R7d (a QA step), R7e (before and after screenshots on an orphan `factory/assets` branch) and R8 (three nightly metric goals). R7a and R7b (conventional titles, one commit per task) are already planned in #225.

## Today
- `template/.factory/charter.md` has `## Risk tiers`, `## Protected paths` and `## STOP_IF`; no section names boundary paths that need a decision record.
- `src/engine/verify-facts.ts:13` `recordVerifyFacts` collects the facts the receipt signs and a tiered merge reads; nothing checks for a `docs/decisions/` change.
- `src/engine/steps.ts:544` the `check` step type runs one shell command in the worktree with no agent and no tokens, and parks the issue as failed on a non-zero exit; `src/engine/steps.ts` is at its 567-line cap, so a QA step reuses `check` rather than adding a type.
- `template/.factory/workflows/feature-to-pr.yml` runs triage, plan, build, verify, pr; there is no QA step.
- `src/merge-autonomy.ts:79` calls `uiFacts` with `baseline: .factory/visual/baseline` and `current: <runDir>/visual`; `src/visual.ts:31` `visualDiffs` compares them by hash. The images never leave the worktree.
- `src/schemas.ts:60` the build artifact's `screenshots` is an array of `{state, viewport, theme, path}`.
- `src/engine/pr-body.ts:77` `prBody(body, parts)` has no QA or screenshots section.
- `src/learn-export.ts:12` yields run, stage and retro JSONL; #212 adds `exportAll` across repos. No script turns it into numbers.
- `scripts/goals.ts:16` a probe proof is a shell script under `scripts/probes/`.

## Change
### T1: docs-touched check (R7c, #67)
Files: `src/docs-check.ts`, `src/engine/verify-facts.ts`, `template/.factory/charter.md`, `tests/docs-check.test.ts`
Model: sonnet
1. Add an optional `## Boundaries` section to `template/.factory/charter.md`: glob lines for paths whose change needs a decision record (for example a public API, a schema, a config format), with a TODO line `factory doctor` already flags.
2. Create `src/docs-check.ts` exporting `boundaryGlobs(charterText)` and `docsMissing(changed, globs)`, which returns the boundary paths changed when no path under `docs/decisions/` changed in the same diff.
3. The rule must be written as exactly this line: `if (changed.some((p) => p.startsWith("docs/decisions/"))) return [];`
4. `recordVerifyFacts` adds `docs: { missing }` to the verify facts; a non-empty list is a blocking verify finding naming each path. No `## Boundaries` section means no check.

### T2: QA step through the check type (R7d, #65)
Files: `template/.factory/qa.sh`, `template/.factory/workflows/feature-to-pr.yml`, `src/qa.ts`, `src/engine/pr-body.ts`, `tests/qa.test.ts`
Model: sonnet
1. `template/.factory/qa.sh` starts the app with `$QA_COMMAND` from the step env, waits for `$QA_URL` to answer, requests each route listed in the plan artifact's `routes` (or `/` when none), and writes `.factory/runs/<issue>/qa.json` as `{ routes: [{ path, status, ok }] }`; it exits 1 when any route fails, and always stops the app.
2. In `feature-to-pr.yml` add a commented `qa` step between verify and pr: `uses: check`, `run: .factory/qa.sh`; it stays off until a repo uncomments it and points `pr`'s predecessor at it, so no config key is added.
3. `src/qa.ts` exports `readQa(worktree, issue)` and `qaSection(qa)` rendering `## QA` with one row per route and its status.
4. `prBody` gains `parts.qa` and renders the section only when `qa.json` exists. The render must be written as exactly this line: `if (parts.qa) out.push(qaSection(parts.qa));`

### T3: before and after shots on factory/assets (R7e, #63)
Files: `src/assets-branch.ts`, `src/engine/pr-body.ts`, `tests/assets-branch.test.ts`
Model: sonnet
1. Create `src/assets-branch.ts` exporting `pairShots(baselineDir, currentDir)` that matches files by name into `{ name, before?, after }`, and `pushAssets(git, worktree, issue, pairs)` that writes the images to the orphan branch `factory/assets` under `<issue>/before/` and `<issue>/after/` with git plumbing (`hash-object -w`, `mktree`, `commit-tree`, `push origin <sha>:refs/heads/factory/assets`), never checking the branch out in the worktree.
2. The first push creates the branch with no parent; later pushes parent on the remote head, so history is append only. The orphan rule must be written as exactly this line: `const parent = head ? ["-p", head] : [];`
3. `prBody` gains `parts.shots` and renders a two-column table per pair with raw URLs `https://raw.githubusercontent.com/<repo>/factory/assets/<issue>/...`; a pair with no `before` reads "new screen". A non-UI change (`isUiChange` false) adds nothing.
4. The build artifact keeps its `screenshots` shape; the URLs are written into the run's `shots.json` for #208's preview tab to read.

### T4: metric goals (R8)
Files: `scripts/metrics.ts`, `scripts/probes/metrics.sh`, `tests/metrics.test.ts`, `goals.json`
Model: haiku
Deps: T1
1. `scripts/metrics.ts` reads export JSONL (`factory learn --export - --all`) and computes, over the last 20 finished runs: `planShare` (plan stage spend over all stage spend), `rejectsPerRun` (verify rejects per run) and `costPerShipped` (spend over merged runs).
2. `--check` exits 1 when `planShare > 0.25`, `rejectsPerRun > 0.5` or `costPerShipped > 1.5`, printing each metric and its bar. The bars must be written as exactly this line: `const BARS = { planShare: 0.25, rejectsPerRun: 0.5, costPerShipped: 1.5 };`
3. With fewer than 20 finished runs it prints the count and exits 0, so a new install does not fail.
4. `scripts/probes/metrics.sh` runs the export into the scratch dir and `bun scripts/metrics.ts --check`; add goal rows `plan-share`, `rejects-per-run` and `cost-per-shipped` as probes in phase P10. These are operator numbers and never reach a customer page.

## Tests
- `tests/docs-check.test.ts`: [permanent] a boundary path changed without a decision record is reported; with one, nothing; no Boundaries section, nothing.
- `tests/qa.test.ts`: [permanent] a qa.json with one failed route renders a QA section with that route failed; no qa.json, no section; `qa.sh` against a tiny fixture server writes the routes and stops the server.
- `tests/assets-branch.test.ts`: [permanent] in a temp repo with a bare remote, two pushes make a two-commit `factory/assets` history whose first commit has no parent; the worktree's HEAD and index are unchanged; a pair missing `before` reads "new screen".
- `tests/metrics.test.ts`: [permanent] a fixture JSONL over the bars fails `--check` naming the metric; one under passes; 19 runs exit 0 with the count.

## Mutation
```json
{"name":"docs: any change passes","file":"src/docs-check.ts","find":"if (changed.some((p) => p.startsWith(\"docs/decisions/\"))) return [];","replace":"return [];","test":"tests/docs-check.test.ts"}
```
```json
{"name":"assets: always parent","file":"src/assets-branch.ts","find":"const parent = head ? [\"-p\", head] : [];","replace":"const parent = [\"-p\", head ?? \"HEAD\"];","test":"tests/assets-branch.test.ts"}
```
```json
{"name":"metrics: bars loosened","file":"scripts/metrics.ts","find":"planShare: 0.25,","replace":"planShare: 1,","test":"tests/metrics.test.ts"}
```

## Acceptance
- AC-1: a boundary change with no decision record is a blocking verify finding: checked by `make test FILES="tests/docs-check.test.ts"` (T1)
- AC-2: with qa enabled the PR body holds a QA section with each route and its result: checked by `make test FILES="tests/qa.test.ts"` (T2)
- AC-3: a UI PR shows before and after images from the orphan factory/assets branch: checked by `make test FILES="tests/assets-branch.test.ts"` (T3)
- AC-4: planShare, rejectsPerRun and costPerShipped are checked against their bars: checked by `make test FILES="tests/metrics.test.ts"` (T4)
- AC-5: steps.ts and every capped file stay within their caps: checked by `make check` (T2)

## Non-goals
- NG-1: conventional commit titles and one commit per task are #225.
- NG-2: no browser driving in QA; it requests routes over HTTP. A Playwright walk per AC is a later issue.
- NG-3: no capture of base-commit screenshots; `before` is the committed baseline the visual diff already uses.
- NG-4: `factory init` writing a release workflow (#67's first half) is left out.

## Files
- `src/docs-check.ts` (new)
- `src/qa.ts` (new)
- `src/assets-branch.ts` (new)
- `src/engine/verify-facts.ts`
- `src/engine/pr-body.ts`
- `template/.factory/charter.md`
- `template/.factory/qa.sh` (new)
- `template/.factory/workflows/feature-to-pr.yml`
- `scripts/metrics.ts` (new)
- `scripts/probes/metrics.sh` (new)
- `goals.json`
- `tests/docs-check.test.ts` (new)
- `tests/qa.test.ts` (new)
- `tests/assets-branch.test.ts` (new)
- `tests/metrics.test.ts` (new)

## Risk: medium
The assets push writes a new branch on the target repo; it is orphan, append only, and never checked out, so it cannot touch the PR branch. The QA step runs the repo's own app command and is off until a repo uncomments it. The docs check can block verify, but only in repos that fill the new charter section. Rollback: revert the PR and delete the `factory/assets` branch.
## Model: sonnet

