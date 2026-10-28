<!-- factory:planned v1 -->
Milestone: M1

## Why
Resume work at the failed stage.

## Today
- `src/derive.ts:108` stageOf ignores failures.

## Change
### T1: Record the stage in the failure marker
Files: `src/engine/failure.ts`, `tests/resume.test.ts`
Model: haiku
1. Add `stage` to the marker.

### T2: Resume at the failed stage
Files: `src/derive.ts`
Deps: T1
Model: sonnet
1. Return `{resumeAt}` from the latest failure.

## Tests
- `tests/resume.test.ts`: build failure resumes at build: plan spy count is 0.

## Mutation
```json
{"name":"resume: always plan","file":"src/derive.ts","find":"resumeAt: stage","replace":"resumeAt: \"plan\"","test":"tests/resume.test.ts"}
```

## Acceptance
- AC-1: a build failure resumes at build: checked by `tests/resume.test.ts` (T1)
- AC-2: retry overrides the stage: checked by `tests/resume.test.ts` (T2)

## Non-goals
- NG-1: no change to the dashboard.

## Files
- `src/engine/failure.ts`
- `src/derive.ts`
- `tests/resume.test.ts` (new)

## Risk: medium
## Model: sonnet
