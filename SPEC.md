<!-- factory:planned v1 -->
Blocked by: #258
Milestone: M2

## Why
Acceptance checking is hard-wired to one script path from one toolkit. A repo that keeps its checker elsewhere, or uses none, should still get the table without editing the core.

## Today
- `src/acceptance.ts:11` `ACCEPTANCE_SCRIPT = "scripts/kaas/check-acceptance.py"` is the only path `runAcceptance` knows.
- `src/config.ts` has `holdout: { paths, cmd }` but no acceptance section.

## Change
### T1: Add an acceptance.script config key
Files: `src/config.ts`, `tests/config.test.ts`
Model: sonnet
1. Add `acceptance: { script: string }` to `FactoryConfig`, default `scripts/kaas/check-acceptance.py`, merged and validated like `holdout`: a non-string value is a problem, `""` turns acceptance off.

### T2: Read the script path from config
Files: `src/acceptance.ts`, `tests/acceptance-table.test.ts`
Model: sonnet
Deps: T1
1. Give `runAcceptance` an optional `script` argument defaulting to `ACCEPTANCE_SCRIPT`; return undefined when it is `""` or the file is absent.
2. Pass `config.acceptance.script` from the caller that builds the verify context.
3. The command printed uses the given path.

## Tests
- `tests/config.test.ts`: default is the kit path; a number is reported; `""` is accepted.
- `tests/acceptance-table.test.ts`: a custom script path is the one executed; `""` runs nothing.

## Mutation
```json
{"name":"acceptance ignores the empty switch","file":"src/acceptance.ts","find":"if (!existsSync(`${worktree}/${ACCEPTANCE_SCRIPT}`)) return undefined;","replace":"","test":"tests/acceptance-table.test.ts"}
```

## Acceptance
- AC-1: `acceptance.script` defaults to the kit path and rejects a non-string: checked by `tests/config.test.ts` (T1)
- AC-2: a custom path is executed and `""` disables acceptance: checked by `tests/acceptance-table.test.ts` (T2)

## Non-goals
- NG-1: the script's JSON verdict format does not change.
- NG-2: no holdout hook; holdout config stays as is.

## Files
- `src/config.ts`
- `src/acceptance.ts`
- `tests/config.test.ts`
- `tests/acceptance-table.test.ts`

## Risk: low
## Model: sonnet

