<!-- factory:planned v1 -->
Blocked by: #257
Milestone: M2

## Why
The core reads roles and the steering command table out of the dashboard, so the core cannot ship or run without the web app. A protocol package that both sides import makes the dashboard optional.

## Today
- `src/integrations/steer.ts:5-6` imports `COMMANDS` from `dashboard/plane/commands` and `atLeast`, `Role` from `dashboard/plane/store`.
- `ROLES`, `Role`, `atLeast`, `isRole` live in `dashboard/plane/store.ts`; `COMMANDS` lives in `dashboard/plane/commands.ts`.
- `package.json` has no `workspaces` key.

## Change
### T1: Create the protocol package
Files: `packages/protocol/index.ts`, `packages/protocol/package.json`, `package.json`, `tests/protocol.test.ts`
Model: sonnet
1. Create `packages/protocol/index.ts` exporting `ROLES`, `Role`, `atLeast`, `isRole` and a `COMMANDS` table of `{action, role}` for approve-plan, revise, answer, retry and cancel. Declare the action type locally as the same five-string union; the package imports nothing from `src/` or `dashboard/`.
2. Add `packages/protocol/package.json` named `@kaas-team/factory-protocol`, private for now, Apache-2.0.
3. Add `"workspaces": ["packages/*"]` to the root `package.json`.
4. Test the role order and that every command maps to a known role.

### T2: Point the core and the dashboard at it
Files: `dashboard/plane/store.ts`, `dashboard/plane/commands.ts`, `src/integrations/steer.ts`
Model: sonnet
Deps: T1
1. In `dashboard/plane/store.ts` re-export `ROLES`, `Role`, `atLeast`, `isRole` from the package and delete the local copies.
2. In `dashboard/plane/commands.ts` import `COMMANDS` from the package; keep a type check that each action is an `InboxAction`.
3. In `src/integrations/steer.ts` import `COMMANDS`, `atLeast`, `Role` from the package, so `src/` no longer imports `dashboard/`.

### T3: Fail any core import of the dashboard
Files: `tests/hexagon.test.ts`
Model: sonnet
Deps: T2
1. Add a rule using the existing `importsOf` and `filesUnder` helpers: no file under `src/` imports `dashboard/`, except `src/cli.ts`, which starts the dashboard and is listed by name.

## Tests
- `tests/protocol.test.ts`: roles order viewer < approver < operator < owner; every command has a known role and one of five actions.
- `tests/hexagon.test.ts`: `src/` imports `dashboard/` only from `src/cli.ts`.

## Mutation
```json
{"name":"steer reads the dashboard again","file":"src/integrations/steer.ts","find":"export function roleFor(steer: Steer): Role {","replace":"import(\"../../dashboard/plane/store\");\nexport function roleFor(steer: Steer): Role {","test":"tests/hexagon.test.ts"}
```

## Acceptance
- AC-1: the protocol package exports the roles and command table with no import from `src/` or `dashboard/`: checked by `tests/protocol.test.ts` (T1)
- AC-2: no file under `src/` except `src/cli.ts` imports `dashboard/`: checked by `tests/hexagon.test.ts` (T3)
- AC-3: the dashboard and steering behave as before: checked by `make check` (T2)

## Non-goals
- NG-1: `src/cli.ts` still starts the dashboard; moving the plane to its own repo is a later task.
- NG-2: no publish of the package.

## Files
- `packages/protocol/index.ts` (new)
- `packages/protocol/package.json` (new)
- `package.json`
- `dashboard/plane/store.ts`
- `dashboard/plane/commands.ts`
- `src/integrations/steer.ts`
- `tests/protocol.test.ts` (new)
- `tests/hexagon.test.ts`

## Risk: medium
## Model: sonnet

