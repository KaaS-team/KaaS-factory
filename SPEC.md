<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E10.2 Commit and QA quality
Milestone: Phase 10 self-improvement
Runner: operator

## Risk: medium

## Why
#334: a defect that escapes (a merged change that is later reverted, or an issue that is reopened) should turn into a test or a rule that would have caught it, and the self-improvement loop may add rules, tests and suppressions but never remove a check or edit calibration labels. Today a revert after a failed live smoke opens the revert PR and nothing else, and nobody looks for reverts done by hand or reopened issues. #335: a UI pass counts only once it is saved as a Playwright spec committed with the change, and a self-healing step may never skip a test or retarget a locator silently: it only proposes a locator diff for review.

## Today
- `src/post-merge.ts`: `RevertSteps` is `{ smoke(); openRevert(sha, why) }`; `watchAfterMerge` returns `{ ok: true }` or `{ ok: false, revert }` after opening the revert PR. `tests/post-merge.test.ts` covers it.
- `src/merge-autonomy.ts`: after a merge with `merge.smokeUrl` set, it calls `watchAfterMerge` with an `openRevert` that pushes a revert branch and calls `deps.github.createPr` with the title `Revert #<pr>`. `AutonomousMergeDeps.github` is `Pick<ScmPort, "mergePr" | "createPr">`; `ScmPort.createIssue(repo, title, body, labels)` exists. `src/cli.ts` passes the real GitHub port; tests pass `as never`.
- Nothing scans for `This reverts commit` in history or for reopened issues.
- `src/learn.ts`: `runLearn` commits retro proposals on a learning branch and refuses, through `outsideAllowedPaths`, any changed file outside `.factory/memory/**` and `.claude/skills/**`. A batch that deletes a skill file inside those paths is pushed.
- `src/tamper.ts` keeps `SKIP`, `FileDiff` and `parseDiff` private; `tamperHits(diff)` is the export.
- `src/visual.ts`: `UiFacts` is `{ changed, preview, smoke, unreviewedDiffs }`; `src/pr-facts.ts` rung 8 refuses a UI change with no preview or smoke, or with visual diffs nobody reviewed. Nothing asks for a committed Playwright spec. `tests/visual.test.ts` compares the whole `UiFacts` with `toEqual`; `tests/second-review.test.ts` and `tests/ported/machinist/merge-policy.test.ts` build a `ui` object literal.
- `src/pr-facts-collect.ts`: `collectVerifyFacts` returns `tamper: tamperHits(diff)`; a non-empty tamper list fails rung 2.
- The UI route references exist twice each and are identical: `.claude/skills/factory-build/references/ui-route.md` and its `template/` copy (capture screenshots), `.claude/skills/factory-verify/references/ui-route.md` and its `template/` copy (the visual check). No healer agent exists.
- `scripts/check-tests-only.ts` (CI) flags an added skip marker in any `tests/` file, so a test that needs a skip line in a diff builds it from parts.

## Change
### T1: a revert opens a follow-up issue
Files: `src/escaped-defect.ts`, `src/post-merge.ts`, `tests/post-merge.test.ts`, `src/merge-autonomy.ts`
Model: sonnet
1. `src/escaped-defect.ts` opens with a three-line comment: an escaped defect is a merged change later reverted or an issue reopened; each opens one follow-up issue that asks for a regression test or a rule that would have caught it; titles start `Escaped defect:` so a rerun never opens a second one. It exports `FOLLOW_UP_PREFIX = "Escaped defect:"` and `followUpIssue(o: { kind: "revert" | "reopen"; ref: string; why: string; sha?: string; link?: string }): { title: string; body: string }`. The title is `` `${FOLLOW_UP_PREFIX} ${o.kind === "revert" ? "reverted" : "reopened"} ${o.ref}` ``. The body states what happened (`o.why`, the sha and the link when given), then: the fix PR must add a regression test that fails at the reverted or reopened change and passes after the fix, or a rule (a lint, a gate step, a tamper pattern) that refuses it; the loop may add tests and rules but never remove one.
2. `src/post-merge.ts`: `RevertSteps` gains `openFollowUp?(sha: string, why: string, revertUrl: string): Promise<void>;` with a one-line comment. `watchAfterMerge` becomes:
   ```ts
   if (await steps.smoke()) return { ok: true };
   const why = "the live smoke failed after merge";
   const revert = await steps.openRevert(sha, why);
   if (steps.openFollowUp) await steps.openFollowUp(sha, why, revert);
   return { ok: false, revert };
   ```
3. `src/merge-autonomy.ts`: `AutonomousMergeDeps.github` becomes `Pick<ScmPort, "mergePr" | "createPr" | "createIssue">`. The `watchAfterMerge` call gains, after `openRevert`:
   ```ts
   openFollowUp: async (sha, why, revertUrl) => {
     const f = followUpIssue({ kind: "revert", ref: `#${run.pr}`, why, sha, link: revertUrl });
     await deps.github.createIssue(config.repo, f.title, f.body, []);
   },
   ```
   plus the import. Nothing else in the file changes.
4. `tests/post-merge.test.ts` gains a test for the follow-up call.

### T2: the nightly escaped-defect scan
Files: `src/escaped-defect.ts`, `scripts/escaped-defects.ts`, `ci/escaped-defects.yml`, `tests/escaped-defect.test.ts`
Model: sonnet
Deps: T1
1. `src/escaped-defect.ts` also exports `interface Escape { kind: "revert" | "reopen"; ref: string; why: string; sha?: string }`, `revertsIn(log: string): Escape[]`, `reopenedIn(events: readonly unknown[], sinceIso: string): Escape[]` and `newFollowUps(found: readonly Escape[], existingTitles: readonly string[]): Escape[]`.
2. `revertsIn` reads the output of `git log --format=%H%x00%s%x00%b%x1e`: records split on `\x1e`, fields on `\x00`. A record whose body holds `This reverts commit <7 to 40 hex>` gives `{ kind: "revert", ref: <reverted sha, first 7>, sha: <reverted sha>, why: "reverted by <revert sha, first 7>: <subject>" }`.
3. `reopenedIn` keeps events with `event === "reopened"`, `created_at >= sinceIso`, and an `issue.title` that does not start with `FOLLOW_UP_PREFIX`, giving `{ kind: "reopen", ref: "#<issue.number>", why: "reopened: <issue.title>" }`, one per issue number. Anything not shaped like that is skipped.
4. `newFollowUps` drops an escape whose `followUpIssue(e).title` is in `existingTitles` or already seen in this list, written exactly as `.filter((e) => !seen.has(followUpIssue(e).title) && Boolean(seen.add(followUpIssue(e).title)))` over a `seen` set seeded with `existingTitles`.
5. `scripts/escaped-defects.ts`: `bun scripts/escaped-defects.ts --repo owner/name [--days 2] [--dry-run]`, opened by a two-line comment. It reads `git log --since="<days> days ago" --format=...` in the cwd, `gh api "repos/<repo>/issues/events?per_page=100"`, and the existing titles from `gh issue list --repo <repo> --state all --search "\"Escaped defect:\" in:title" --json title --limit 1000`, then for each new follow-up runs `gh issue create --repo <repo> --title <title> --body <body>`, or prints the title with `--dry-run`. It prints `escaped-defects: <n> new follow-up(s)` and exits 0; a failed `gh` call exits 1 with its stderr. Exit 2 with a usage line when `--repo` is missing.
6. `ci/escaped-defects.yml`: `name: escaped-defects`, `on:` a `schedule` with `cron: "23 4 * * *"` and `workflow_dispatch`, `permissions: contents: read` and `issues: write`, one job on `ubuntu-latest` with `timeout-minutes: 5`: `actions/checkout@v4` with `fetch-depth: 0`, `oven-sh/setup-bun@v2` with `bun-version: "1.3"`, then a step running `bun scripts/escaped-defects.ts --repo "${{ github.repository }}" --days 2` with `env: GH_TOKEN: ${{ github.token }}`.
7. `tests/escaped-defect.test.ts` holds the unit tests and the wiring check.

### T3: the loop never removes a check
Files: `src/loop-guard.ts`, `tests/loop-guard.test.ts`, `src/learn.ts`, `tests/learn.test.ts`
Model: haiku
1. `src/loop-guard.ts` opens with a two-line comment: what the self-improvement loop may never do: delete a file (a check, a test, a skill) or edit the calibration labels. It exports `CALIBRATION_PATHS = ["tests/fixtures/judge-calibration/**"]` and `loopRefusals(changed: readonly string[], exists: (path: string) => boolean): string[]`. For each changed path it pushes `` `${f}: deleted` `` when `!exists(f)`, written exactly as `if (!exists(f)) out.push(`, and `` `${f}: calibration label` `` when `outsideAllowedPaths([f], CALIBRATION_PATHS)` is empty (imported from `./boundary`, as `src/learn.ts` does).
2. `src/learn.ts`: in `runLearn`, directly after `const changed = ...`, add `const refused = loopRefusals(changed, (f) => existsSync(join(worktreeDir, f)));` and `if (refused.length) throw new Error(\`factory learn: the loop may add, never remove or relabel: ${refused.join(", ")}\`);`, before the existing allowed-paths check. Add the imports. The comment above `runLearn` gains one sentence naming this refusal.
3. `tests/learn.test.ts` gains one test: a batch whose `git.changed` is `[".claude/skills/factory-build/SKILL.md"]` (not on disk in the worktree) rejects with `/never remove/`, pushes nothing and leaves the row pending.

### T4: a UI change needs a committed Playwright spec
Files: `src/visual.ts`, `src/pr-facts.ts`, `tests/visual.test.ts`, `tests/second-review.test.ts`, `tests/ported/machinist/merge-policy.test.ts`, `.claude/skills/factory-build/references/ui-route.md`, `template/.claude/skills/factory-build/references/ui-route.md`
Model: sonnet
1. `src/visual.ts`: export `const isQaSpec = (path: string) => /\.(spec|e2e)\.[cm]?[jt]sx?$/.test(path);`. `UiFacts` gains `readonly qaSpec: boolean;`. The non-UI return gains `qaSpec: false`; the UI return gains `qaSpec: paths.some(isQaSpec),`. The header comment gains: and a committed Playwright spec.
2. `src/pr-facts.ts`: the `ui` facts type gains `readonly qaSpec: boolean;` and its comment names it. After the preview and smoke line in rung 8 add `if (ui.changed && !ui.qaSpec) out.push(fail(8, "a UI change has no committed Playwright spec"));`.
3. `tests/visual.test.ts`: the whole-object expectation gains `qaSpec: false`; add a case where `["web/components/Cart.tsx", "e2e/cart.spec.ts"]` gives `qaSpec: true`, and `factRefusals` details for the first `ui` contain `8: a UI change has no committed Playwright spec`. `tests/second-review.test.ts` and `tests/ported/machinist/merge-policy.test.ts`: the `ui` literal gains `qaSpec: false`. No other change in those two files.
4. Both `factory-build/references/ui-route.md` copies gain, byte-identical, a closing paragraph: QA output is a Playwright spec committed with the change (`*.spec.ts` or `*.e2e.ts`) that drives the AC states; it fails on the parent commit and passes on head; a UI change with no spec cannot merge on its own (rung 8).

### T5: the healer only proposes locator diffs
Files: `src/tamper.ts`, `src/healer.ts`, `tests/healer.test.ts`, `src/pr-facts-collect.ts`, `.claude/skills/factory-verify/references/ui-route.md`, `template/.claude/skills/factory-verify/references/ui-route.md`
Model: sonnet
Deps: T4
1. `src/tamper.ts`: add `export` to `const SKIP`, `interface FileDiff` and `function parseDiff`. No other change.
2. `src/healer.ts` opens with a three-line comment: a self-healing step never edits a spec in place; it writes a proposed diff to the run dir's `heal.diff`, and this guard refuses one that touches a non-spec file, deletes a spec, adds a skip or fixme, or changes anything but a locator. It exports `HEAL_FILE = "heal.diff"`, `LOCATOR = /\b(?:getBy(?:Role|Text|Label|Placeholder|AltText|Title|TestId)|locator)\((?:[^()]|\([^()]*\))*\)/g`, `healerProblems(diff: string): string[]` and `healFindings(worktree: string, issue: number): string[]`.
3. `healerProblems` walks `parseDiff(diff)` and per file pushes: `` `${f.path}: the healer may only edit a Playwright spec` `` when `!isQaSpec(f.path)`; `` `${f.path}: the healer deleted a spec` `` when `f.deleted`; `` `${f.path}: the healer marks a test skipped` `` with exactly `if (f.added.some((l) => SKIP.some((re) => re.test(l)) || FIXME.test(l))) out.push(` where `const FIXME = /\.fixme\s*\(/;`; and `` `${f.path}: the healer changed more than locators` `` with exactly `if (shape(f.removed) !== shape(f.added)) out.push(`, where `shape(lines)` replaces every `LOCATOR` match with `LOCATOR`, trims each line, drops empty lines, sorts, and joins with `\n`.
4. `healFindings` reads `<worktree>/<runDir(issue)>/heal.diff` when it exists and returns `healerProblems(text).map((p) => \`heal.diff: ${p}\`)`, else `[]`.
5. `src/pr-facts-collect.ts`: the returned `tamper` becomes `[...tamperHits(diff), ...healFindings(worktree, issue)]`, so a bad heal fails rung 2 like any tamper hit. Add the import; no other change.
6. Both `factory-verify/references/ui-route.md` copies gain, byte-identical, a closing paragraph: a healer never edits a spec; it writes its proposed locator changes as a unified diff to the run dir's `heal.diff` for a person to review, and the runner refuses one that touches a non-spec file, deletes a spec, adds a skip or fixme, or changes anything but a locator.
7. `tests/healer.test.ts` builds every diff inline. Any skip or fixme text is assembled from parts, for example `["test", "skip"].join(".") + "("`, so `scripts/check-tests-only.ts` does not read the test file as adding one.

### T6: wire and deliver
Files: `tests/mutations.json`
Model: haiku
Deps: T1, T2, T3, T4, T5
1. `tests/mutations.json` gains the entries from ## Mutation, one per line in the file's existing style, inserted directly after the line whose name is `visual: a changed screenshot is an unreviewed diff`. Append nothing at the end.
2. Run `make check`, `make check-mutations MUTATION_ARGS="--base origin/main"` and `bun scripts/escaped-defects.ts --repo KaaS-team/KaaS-factory --days 30 --dry-run` (read only); all pass.
3. Delivery: one PR for this plan. The PR body fills every section of `.github/pull_request_template.md`. Every commit carries a `Signed-off-by:` line (`git commit -s`). No em dashes in code, comments, docs or the PR body. No file outside ## Files changes. New tests use no `toBeTruthy`, `toBeFalsy`, `toBeDefined`, `toBeUndefined` or `expect.anything()`.

## Tests
- `tests/post-merge.test.ts`: [permanent] a failing smoke with `openFollowUp` set opens the revert, then calls the follow-up once with the same sha, the why and the revert URL; a passing smoke calls neither; steps with no `openFollowUp` still revert.
- `tests/escaped-defect.test.ts`: [permanent] `followUpIssue` titles start `Escaped defect:` and the body asks for a regression test that fails at the change; `revertsIn` finds the reverted sha in a three-record log and skips records with no revert line; `reopenedIn` keeps a reopened issue inside the window, skips one before it, a `closed` event, a follow-up issue and a malformed event; `newFollowUps` drops a title that already exists and a duplicate within the list; `ci/escaped-defects.yml` or `.github/workflows/escaped-defects.yml` runs `bun scripts/escaped-defects.ts`, has a `schedule` and grants `issues: write`.
- `tests/loop-guard.test.ts`: [permanent] an added or edited file passes; a deleted file is refused as `deleted`; `tests/fixtures/judge-calibration/cases.json` is refused as `calibration label`.
- `tests/learn.test.ts`: [permanent] a batch that deletes a skill file is refused before any push.
- `tests/visual.test.ts`: [permanent] `qaSpec` is false with no spec and true with `e2e/cart.spec.ts`; a UI change with no spec is refused at rung 8.
- `tests/healer.test.ts`: [permanent] a diff that only changes `getByRole("button", { name: "Pay" })` to `getByTestId("pay")` in `e2e/cart.spec.ts` has no problems; a diff that also changes an `expect` line, one that adds a skip, one that adds a fixme, one that deletes the spec, and one that touches `src/cart.ts` each give their named problem; `healFindings` returns `[]` with no `heal.diff` and prefixed problems with a bad one; both verify `ui-route.md` copies are identical and mention `heal.diff`, and both build copies are identical and mention `Playwright spec`.

## Mutation
```json
{"name":"escape: a revert opens a follow-up","file":"src/post-merge.ts","find":"if (steps.openFollowUp) await steps.openFollowUp(sha, why, revert);","replace":"","test":"tests/post-merge.test.ts"}
```
```json
{"name":"escape: a follow-up is opened once","file":"src/escaped-defect.ts","find":".filter((e) => !seen.has(followUpIssue(e).title) && Boolean(seen.add(followUpIssue(e).title)))","replace":".filter(() => true)","test":"tests/escaped-defect.test.ts"}
```
```json
{"name":"loop guard: the loop never deletes a file","file":"src/loop-guard.ts","find":"if (!exists(f)) out.push(","replace":"if (false) out.push(","test":"tests/loop-guard.test.ts"}
```
```json
{"name":"qa: a UI change needs a committed spec","file":"src/visual.ts","find":"qaSpec: paths.some(isQaSpec),","replace":"qaSpec: true,","test":"tests/visual.test.ts"}
```
```json
{"name":"healer: a heal never skips a test","file":"src/healer.ts","find":"if (f.added.some((l) => SKIP.some((re) => re.test(l)) || FIXME.test(l))) out.push(","replace":"if (false) out.push(","test":"tests/healer.test.ts"}
```
```json
{"name":"healer: a heal changes only locators","file":"src/healer.ts","find":"if (shape(f.removed) !== shape(f.added)) out.push(","replace":"if (false) out.push(","test":"tests/healer.test.ts"}
```

## Acceptance
- AC-1: a change reverted after a failed live smoke opens a follow-up issue that requires a regression test: checked by `tests/post-merge.test.ts` (T1)
- AC-2: a nightly job opens one follow-up per revert or reopened issue, never two for the same one: checked by `tests/escaped-defect.test.ts` (T2)
- AC-3: the learning loop cannot delete a check or edit calibration labels: checked by `tests/loop-guard.test.ts` (T3)
- AC-4: the learning run refuses such a batch before it pushes: checked by `tests/learn.test.ts` (T3)
- AC-5: a UI change merges on its own only with a committed Playwright spec: checked by `tests/visual.test.ts` (T4)
- AC-6: a healer diff cannot skip a test or change anything but locators, and a bad one fails the PR facts: checked by `tests/healer.test.ts` (T5)

## Non-goals
- NG-1: no healer agent; this plan ships only the guard and the `heal.diff` contract.
- NG-2: verify does not yet check that the fix PR for a follow-up adds the regression test; that belongs to #314.
- NG-3: no check that the committed spec fails on the parent commit; the proof stage already runs the plan's proof against base.
- NG-4: no edit to `.github/workflows/`; the build stages `ci/escaped-defects.yml` and the operator moves it, then deletes `ci/`.
- NG-5: no labels on follow-up issues.

## Files
- `src/escaped-defect.ts` (new)
- `scripts/escaped-defects.ts` (new)
- `ci/escaped-defects.yml` (new)
- `tests/escaped-defect.test.ts` (new)
- `src/loop-guard.ts` (new)
- `tests/loop-guard.test.ts` (new)
- `src/healer.ts` (new)
- `tests/healer.test.ts` (new)
- `src/post-merge.ts` (edit: the follow-up step)
- `tests/post-merge.test.ts` (edit: follow-up cases)
- `src/merge-autonomy.ts` (edit: open the follow-up issue)
- `src/learn.ts` (edit: call `loopRefusals`)
- `tests/learn.test.ts` (edit: a deleted skill file is refused)
- `src/visual.ts` (edit: `qaSpec`)
- `src/pr-facts.ts` (edit: rung 8 needs a spec)
- `tests/visual.test.ts` (edit: `qaSpec` cases)
- `tests/second-review.test.ts` (edit: `qaSpec: false` in the ui literal)
- `tests/ported/machinist/merge-policy.test.ts` (edit: `qaSpec: false` in the ui literal)
- `.claude/skills/factory-build/references/ui-route.md` (edit: commit a Playwright spec)
- `template/.claude/skills/factory-build/references/ui-route.md` (edit: commit a Playwright spec)
- `src/tamper.ts` (edit: export `SKIP`, `FileDiff`, `parseDiff`)
- `src/pr-facts-collect.ts` (edit: heal problems join the tamper list)
- `.claude/skills/factory-verify/references/ui-route.md` (edit: the `heal.diff` contract)
- `template/.claude/skills/factory-verify/references/ui-route.md` (edit: the `heal.diff` contract)
- `tests/mutations.json` (edit: add the six entries after the visual entry)
