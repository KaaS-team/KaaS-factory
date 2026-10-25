<!-- factory:plan v1 rev=1 -->
## Plan (rev 1)

**Goal:** Make `exportCsv` (shared by the CSV route and `splitbill export`) print the amount column as a 2-decimal string via `formatCents`, not raw integer cents.

### Acceptance criteria
- **AC-1:** `exportCsv` renders each row's amount with `formatCents`, e.g. an expense of 1000 cents reads `10.00` and 4500 reads `45.00` (seeded `flat-4b` data): checked by `bun test tests/csv.test.ts` ("exportCsv formats the amount column as a decimal")
- **AC-2:** Amounts whose cents part is non-zero or below 10 keep both digits (e.g. 1005 -> `10.05`, 1050 -> `10.50`): checked by `bun test tests/csv.test.ts` ("exportCsv keeps two decimal places")
- **AC-3:** The header row (`date,payer,description,amount`), the row count and the other columns stay the same: checked by `bun test tests/csv.test.ts` ("exportCsv keeps header and row count") plus the existing `tests/routes.test.ts` and `tests/cli.test.ts` export tests
- **AC-4:** The full gate passes: checked by `make check`

### Non-goals (binding; a diff that crosses one fails verify)
- **NG-1:** No change to `src/money/**`: `formatCents` is reused as it is, not edited or duplicated in a new helper.
- **NG-2:** No change to the CSV header, the column order, the date/payer/description formatting, or `csvEscape`.
- **NG-3:** No change to the DB schema, the stored `amount_cents` values, or the SQL query in `fetchExpenseRows`.
- **NG-4:** No change to the route handlers in `src/routes/**` or to `src/cli.ts`; both already call `exportCsv`, so they pick up the fix with no edits.
- **NG-5:** No edits to protected paths (`src/auth/**`, `.factory/**`, `.claude/**`, `.agents/**`, `.github/**`).

### Files to touch
- `src/csv.ts`: import `formatCents` from `./money/index.ts` and use it for the amount column. Also delete the stale "SEEDED DEFECT" doc comment, which this fix makes untrue.
- `tests/csv.test.ts` (new): unit tests for `exportCsv`, using an in-memory `new Database(":memory:")` with `initSchema` + `seedDemoData`, plus a directly inserted expense for the 1005/1050 cases.

### Tests to write first
- `tests/csv.test.ts` › `exportCsv formats the amount column as a decimal`
- `tests/csv.test.ts` › `exportCsv keeps two decimal places`
- `tests/csv.test.ts` › `exportCsv keeps header and row count`

### Repo skills to apply
handling-money (format only at the output edge; integer cents stay integers internally)

### Risk: low
Charter **low** tier: "a change confined to a single non-protected module with no schema or API-shape change". Only `src/csv.ts` changes, plus a new test file. The CSV's columns and the route stay as they are; only how the amount value is rendered changes, which is the bug fix.

**Gate level:** full

Low risk: eligible for auto-approve if the toggle is on. Otherwise, reply
`/factory approve` to proceed, or `/factory revise <what to change>`.