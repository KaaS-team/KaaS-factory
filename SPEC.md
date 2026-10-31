<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: #151
Epic: e2-reliability
Milestone: phase-1
Runner: factory

## Risk: medium

## Why
A planned issue lists mutations: small edits that the named test must catch. Today the verify stage never runs them, so a build can pass verify with tests that would not notice the bug the plan named. #139 built the runner and the verify wiring on a branch, but it never merged, and its `src/engine/steps.ts` hunk grows a file frozen by the quality baseline. This spec lands the runner, runs every plan mutation in verify, and rejects the build with the mutation's name when its test still passes. The file is always put back, even when the test throws. To make room in `src/engine/steps.ts`, the three copies of the verify reject block become one helper, so the file shrinks. Closes #42.

## Today
- `src/engine/verify-facts.ts:33-38` `proofInputs` returns `planProof` and `testCmd` only. Nothing reads `plan.json`'s `mutations`.
- `src/engine/steps.ts` is 593 lines, frozen at 593 at `quality-baseline.json:133`. It has two copies of the reject block, for holdout (`:353-366`) and acceptance (`:399-410`), and each one bumps `ctx.rejectRound`, sets `ctx.failure`, posts a verify comment, and past `maxRejects` moves the label, runs the retro and finishes `needs-human`.
- Salvage: branch `factory/issue-139` changes `src/proof.ts`, `src/engine/verify-facts.ts`, `src/engine/steps.ts`, `tests/mutate.test.ts`, `quality-baseline.json` and `tests/mutations.json`. Against main, `quality-baseline.json` and `tests/mutations.json` conflict. Its `src/proof.ts` hunk (264 lines after) adds `PlanMutation`, `MutationResult` (`bites`, `survives`, `unapplied`), `MutationIO`, `isMutation`, `runMutations` (which restores each file from the bytes it read, in `finally`, and refuses a path outside the worktree), `ShellMutationIO` (a timeout, then SIGKILL) and `ProofGit.mutations`. Its `src/engine/verify-facts.ts` hunk adds `mutations` to `proofInputs`, plus `MutationFindings` and `survivingMutations`. `survivingMutations` runs each mutation's test through the test gate's `fileCmd`, or else the whole gate, and only a survivor or a failed run rejects. Its `tests/mutate.test.ts` hunk adds the `runMutations`, `survivingMutations`, `ShellMutationIO` and "verify with plan mutations" describes. These three files are kept.
- A prototype on main checked the result. It took those three hunks plus the `src/engine/steps.ts` change in T2. `src/engine/steps.ts` came to 588 lines, `bunx biome check` and `bunx tsc --noEmit` were clean, and `tests/mutate.test.ts` (40), `tests/holdout.test.ts`, `tests/acceptance.test.ts` and `tests/receipt.test.ts` passed. Each of the four mutations below failed at least one test.

## Change
### T1: the mutation runner and the verify finding
Files: `src/proof.ts`, `src/engine/verify-facts.ts`, `tests/mutate.test.ts`
Model: haiku
1. `git fetch origin factory/issue-139 && git diff origin/main...origin/factory/issue-139 -- src/proof.ts src/engine/verify-facts.ts tests/mutate.test.ts | git apply -3`. Do not take the branch's `src/engine/steps.ts`, `quality-baseline.json` or `tests/mutations.json`.
2. Confirm that `src/proof.ts` contains `r.code === 0 ? "survives" : "bites"` and `await io.write(worktree, m.file, original);` once each, and that `src/engine/verify-facts.ts` contains `reject: survivors.length > 0` once.
3. `bun test tests/mutate.test.ts` passes. The "verify with plan mutations" tests need T2.

### T2: verify runs the plan's mutations, with one reject helper
Files: `src/engine/steps.ts`, `quality-baseline.json`
Model: sonnet
Deps: T1
1. Import `survivingMutations` from `./verify-facts`, next to `proofInputs`.
2. Add this helper just above `const verify: StepType = {`:
```ts
// A check the build failed is the build's to fix: send it back, or past the reject limit hand it to a person.
async function rejectToBuild(sc: StepCtx, body: string, json: object, why: string): Promise<StepResult> {
  const { deps, config, issue, ctx, step } = sc;
  ctx.rejectRound += 1;
  ctx.failure = failureTail(body);
  await postComment(deps, config, issue.number, body, { stage: "verify", json });
  if (ctx.rejectRound <= sc.workflow.limits.rejects) return { kind: "reject" };
  await moveLabel(deps, config, issue.number, step.label, LABEL.needsHuman);
  await runRetro(deps, config, issue, "gave-up");
  finish(deps, config, issue.number, "needs-human", `${why} ${ctx.rejectRound} times`);
  return stop("needs-human");
}
```
3. Replace the 14-line holdout block that starts `if (!holdout.ok) {` with these two lines:
```ts
      const failed = `Holdout tests failed:\n\n\`\`\`\n${holdout.detail}\n\`\`\``;
      if (!holdout.ok) return rejectToBuild(sc, failed, { holdout: holdout.detail }, "holdout tests failed");
```
4. Destructure `mutations` from `proofInputs(...)`. Directly after `await recordVerifyFacts(worktree, config, issueNumber, testCmd, proof);`, add:
```ts
      const survived = await survivingMutations(deps.proofGit, worktree, config, mutations);
      const found = survived && { survivingMutations: survived.names };
      if (survived?.reject) return rejectToBuild(sc, survived.body, found!, "plan mutations survived");
      if (survived) await postComment(deps, config, issueNumber, survived.body, { stage: "verify", json: found });
```
5. In the acceptance block, keep `const table = renderAcceptanceTable(ownAcceptance);` and replace the rest of the block body with `return rejectToBuild(sc, table, { acceptance: ownAcceptance }, "acceptance not proven");`. Keep `maxRejects` if any other line in the file still reads it.
6. Set `lines["src/engine/steps.ts"]` in `quality-baseline.json` to the new size from `wc -l src/engine/steps.ts` (588 in the prototype). It must be below 593. Change no other value.
7. `bun test tests/mutate.test.ts tests/holdout.test.ts tests/acceptance.test.ts tests/receipt.test.ts tests/quality.test.ts` passes, and `bunx biome check` and `bunx tsc --noEmit` are clean.

### T3: the mutation files
Files: `tests/mutations/plan-mutations-a-survivor-counts-as-bites.json`, `tests/mutations/plan-mutations-the-mutated-file-is-not-put-back.json`, `tests/mutations/verify-a-surviving-plan-mutation-does-not-reject.json`, `tests/mutations/plan-mutations-findings-never-reject.json`
Model: haiku
Deps: T2
1. Write each entry under Mutation to its own file in `tests/mutations/`, named by the entry's slug. The names are listed in this task's Files line. Use two-space JSON with keys in the order name, file, find, replace, test, and a trailing newline: the per-entry format from #151. Do not edit `tests/mutations.json`.
2. Run `bun scripts/check-mutations.ts "<name>"` for each of the four names. Each must print `bites`.

## Tests
- `tests/mutate.test.ts`: [permanent] a surviving mutant is reported by name; a failing test is bites; the file is restored byte for byte even when the test throws; a path outside the worktree is refused; a find text that is gone is reported but does not reject; a survivor rejects verify, and past the reject limit the issue goes to `needs-human`.
- `tests/holdout.test.ts`, `tests/acceptance.test.ts`, `tests/receipt.test.ts`: [permanent] existing; the holdout and acceptance rejects behave as before through the shared helper.
- `tests/quality.test.ts`: [permanent] existing; `src/engine/steps.ts` shrinks to its new baseline.

## Mutation
```json
{"name":"plan mutations: a survivor counts as bites","file":"src/proof.ts","find":"r.code === 0 ? \"survives\" : \"bites\"","replace":"r.code === 0 ? \"bites\" : \"survives\"","test":"tests/mutate.test.ts"}
```
```json
{"name":"plan mutations: the mutated file is not put back","file":"src/proof.ts","find":"await io.write(worktree, m.file, original);","replace":"","test":"tests/mutate.test.ts"}
```
```json
{"name":"plan mutations: findings never reject","file":"src/engine/verify-facts.ts","find":"reject: survivors.length > 0","replace":"reject: false","test":"tests/mutate.test.ts"}
```
```json
{"name":"verify: a surviving plan mutation does not reject","file":"src/engine/steps.ts","find":"if (survived?.reject) return rejectToBuild(sc, survived.body","replace":"if (false) return rejectToBuild(sc, survived.body","test":"tests/mutate.test.ts"}
```
All four finds exist only after the change. In the prototype, each matched once and bit.

## Acceptance
- AC-1: each plan mutation runs against its test, the file is put back even when the test throws, and a mutation whose test still passes is reported by name: checked by `make test FILES=tests/mutate.test.ts` (T1)
- AC-2: verify rejects a build when a plan mutation survives, and hands the issue to a person past the reject limit: checked by `make test FILES=tests/mutate.test.ts` (T2)
- AC-3: holdout and acceptance rejects behave as before: checked by `make test FILES=tests/holdout.test.ts` (T2)
- AC-4: `src/engine/steps.ts` shrinks and its baseline is its size: checked by `make test FILES=tests/quality.test.ts` (T2)

## Non-goals
- NG-1: no filtering of the acceptance table and no change to how the plan stage writes `mutations` into `plan.json` (separate issues).
- NG-2: no change to `scripts/check-mutations.ts` or the repo's own mutation list beyond the four new files.
- NG-3: do not touch `.github/workflows`, and do not edit `tests/mutations.json`; mutations go in `tests/mutations/` (#151).
- NG-4: one PR for this spec, whose body follows `.github/pull_request_template.md`. Every commit carries the `Signed-off-by:` line from `CONTRIBUTING.md`. No em dashes in code, comments or the PR. Touch nothing outside Files.

## Files
- `tests/mutations/plan-mutations-a-survivor-counts-as-bites.json` (new)
- `tests/mutations/plan-mutations-the-mutated-file-is-not-put-back.json` (new)
- `tests/mutations/plan-mutations-findings-never-reject.json` (new)
- `tests/mutations/verify-a-surviving-plan-mutation-does-not-reject.json` (new)
- `src/proof.ts` (edit: the mutation runner)
- `src/engine/verify-facts.ts` (edit: `proofInputs` returns `mutations`; `survivingMutations`)
- `src/engine/steps.ts` (edit: `rejectToBuild` helper; verify runs plan mutations)
- `tests/mutate.test.ts` (edit: runner and verify tests)
- `quality-baseline.json` (edit: `src/engine/steps.ts` lowered to its size)
