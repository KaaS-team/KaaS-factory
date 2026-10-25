---
name: handling-money
description: Use whenever code touches an amount of money in splitbill - splitting an expense, formatting an amount for display or CSV, or parsing an amount from user input. Covers the integer-cents convention and the remainder rule so splits always sum to the original total.
---

# Handling money

splitbill stores every amount as an **integer number of cents**. Never use a
float for money: floats cannot represent cents exactly and errors compound
across many expenses.

## Rules

1. **Storage and math are integers.** `amountCents: number` is always a
   whole number. Multiply/divide, then round to an integer cent before
   storing or comparing.
2. **Splitting must not lose cents.** When an amount is split N ways, the
   shares must sum to exactly the original amount. Flooring every share
   (`Math.floor(total / n)`) silently loses up to `n - 1` cents. Instead:
   compute the floored base share, then hand the leftover remainder cents
   out one at a time to the first `remainder` members (see
   `references/rules.md` for the exact algorithm and a worked example).
3. **Format only at the edge.** Convert cents to a display string
   (`"10.00"`) only in output (JSON for the UI, CSV, CLI text). Internal
   code, tests and the database always use integer cents.
4. **Every change gets a sum-invariant check.** After touching split logic,
   run `scripts/check-cents.ts` (or add a case to it) to confirm shares sum
   to the input total for both even and uneven splits.

## When you're asked to fix a money bug

1. Read `references/rules.md` for the remainder rule and formatting
   convention before touching code.
2. Write a failing test first: an amount that does NOT divide evenly by the
   number of members (e.g. 1000 cents over 3 people), asserting the shares
   sum to the total.
3. Fix `src/money/cents.ts`, keeping amounts as integers throughout.
4. Run `bun run .claude/skills/handling-money/scripts/check-cents.ts` and
   `make check`; both must pass before the change is done.

## Where this applies in splitbill

`src/money/cents.ts` (split, format, parse), `src/csv.ts` (export
formatting), `src/cli.ts` (`balances`/`export` output), `public/index.html`
(display only, already formats via `/100`).
