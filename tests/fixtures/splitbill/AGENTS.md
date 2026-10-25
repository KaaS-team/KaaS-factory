# AGENTS.md

## Stack

Bun + TypeScript (strict) + Hono + `bun:sqlite`. No frontend framework or
build step - `public/index.html` is served as a static file.

## Commands

- `make install` - `bun install`
- `make dev` - serve on :3200, seeding demo data on first run
- `make test` - `bun test`
- `make typecheck` - `tsc --noEmit`
- `make check` - typecheck + test + skills validation (what CI runs)
- `make audit` / `make outdated` - dependency checks (not part of `check`)

## Layout

- `src/money/` - integer-cents math (split, format, parse). Read
  `.claude/skills/handling-money` before touching this.
- `src/auth/` - token lookup and permission checks. **Protected**: see
  below.
- `src/db.ts` - schema and connection.
- `src/expenses.ts`, `src/balances.ts`, `src/csv.ts` - domain logic.
- `src/routes/` - thin Hono HTTP handlers; no business logic here.
- `src/server.ts` - app assembly + `Bun.serve` entrypoint.
- `src/cli.ts` - `splitbill groups|balances <group>|export <group>`.
- `tests/` - one file per module, `bun:test`. Tests mirror `src/`.

## Money convention

All amounts are an **integer number of cents**. Never use a float for
money. Splitting must not lose cents - see
`.claude/skills/handling-money/references/rules.md` for the remainder
rule. Format to a decimal string only at output boundaries (JSON, CSV,
CLI text).

## Protected

`src/auth/**` is a protected path (see `.factory/charter.md`): a factory
agent must not edit it directly; changes there need a human PR, reviewed
by the `src/auth/` CODEOWNER. `.factory/**`, `.claude/**`, `.agents/**`
and `.github/**` are also protected (the factory's own control surface).

## Tests

Every route, money function and permission check gets a `bun:test` in
`tests/`, named after the module it covers. Use an in-memory
`new Database(":memory:")` and `initSchema`/`seedDemoData` from `src/db.ts`
/ `src/seed.ts` - never touch the on-disk `splitbill.sqlite`.
