<!-- factory:planned v1 -->
Blocked by: none

## Why
Issues #83, #74, #76 and #85 stayed open after their work merged, because the merging PRs closed a re-filed duplicate instead. The board then looks stuck and people close issues by hand. The factory should notice a likely duplicate before it builds, and close an issue once the one that replaced it has shipped.

## Today
- `src/blockers.ts` `resolveBlockers` already runs once per poll over the ready and blocked issues, so it is the place that can see both lists without a new call in `src/watch.ts` (that file is at its line cap).
- Nothing compares a new issue with open ones. Nothing reads a `Superseded by #N` or `Duplicate of #N` line.
- `TrackerPort` already has `listOpenIssues`, `getIssue`, `commentIssue`, `setStateLabel` and `closeIssue`.

## Change
### T1: Detect a likely duplicate and a shipped replacement
Files: `src/duplicates.ts`, `tests/duplicates.test.ts`
Model: sonnet
1. Export `titleWords(title: string): Set<string>`: lowercase words of three or more letters or digits.
2. Export `filesOf(body: string): string[]`: the backticked paths under the `## Files` heading, sorted. No heading means an empty list.
3. Export `likelyDuplicate(a: {title: string; body: string}, b: {title: string; body: string}): boolean`. It is true only when both file lists are non-empty and equal, and the titles share four or more words. Write the word check as `if (shared < 4) return false;`.
4. Export `supersededBy(body: string): number | undefined`: the number in a line `Superseded by #N` or `Duplicate of #N`, case-insensitive.
5. Export `reconcileDuplicates(github, repo, ready)`: returns the numbers it parked. It calls `listOpenIssues` once, and only when `ready` is not empty.
   - For each ready issue with a `supersededBy` target: fetch the target; when it is closed and not "not planned", comment `Shipped in #N.` and close the issue.
   - For each ready issue that is `likelyDuplicate` of a lower-numbered open issue: comment `Possible duplicate of #N. Close this one or say how it differs.` once, then move it to `factory:needs-info`. A second comment is never posted.

### T2: Run it from the dependency gate
Files: `src/blockers.ts`, `tests/blockers.test.ts`
Model: haiku
Deps: T1
1. At the top of `resolveBlockers`, call `reconcileDuplicates` and drop the numbers it returned from `ready`.
2. A reconcile error is logged and ignored: a failed duplicate check must not stop dispatch.

## Tests
- `tests/duplicates.test.ts`: two issues with equal Files and five shared title words are a likely duplicate; one shared file fewer is not; three shared words is not; an issue with no Files section is never a duplicate.
- `tests/duplicates.test.ts`: `supersededBy` reads both phrasings and returns undefined for neither.
- `tests/duplicates.test.ts`: with a fake tracker, a ready issue saying `Superseded by #5` where #5 is closed completed is commented once and closed; where #5 is open it is left alone.
- `tests/duplicates.test.ts`: a likely duplicate is moved to needs-info with one comment, and a second poll adds no second comment.
- `tests/blockers.test.ts`: a parked duplicate is not in `clear`.

## Mutation
```json
{"name":"three shared words count as a duplicate","file":"src/duplicates.ts","find":"if (shared < 4) return false;","replace":"if (shared < 1) return false;","test":"tests/duplicates.test.ts"}
```

## Acceptance
- AC-1: equal Files and four shared title words is a likely duplicate, fewer is not: checked by `make test FILES="tests/duplicates.test.ts"` (T1)
- AC-2: an issue superseded by a closed-completed issue is closed with one comment: checked by `make test FILES="tests/duplicates.test.ts"` (T1)
- AC-3: a likely duplicate is parked once and leaves the dispatch list: checked by `make test FILES="tests/blockers.test.ts tests/duplicates.test.ts"` (T2)

## Non-goals
- NG-1: no change to `src/watch.ts`.
- NG-2: only open issues are compared; closed ones are not searched.
- NG-3: no model call; the check is word and path matching only.

## Files
- `src/duplicates.ts` (new)
- `src/blockers.ts`
- `tests/duplicates.test.ts` (new)
- `tests/blockers.test.ts`

## Risk: low
## Model: sonnet

