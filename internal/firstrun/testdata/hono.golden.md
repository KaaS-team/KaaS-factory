# Factory first-run scorecard

Score now: 65. Projected after the fixes below: 67.

## Top 3 risks

1. Pull request CI time cap (.github/workflows/autofix.yml)
2. Committed build output (build/declaration-emit.test.ts)
3. Duplicate files (src/adapter/deno/deno.d.ts)

## What the factory would fix

| Finding | Pack | Size | Estimate | Score after |
|---|---|---|---|---|
| agent-context (repo-wide) | hygiene | S | ~150k tokens, ~10 min | 66 |
| gate-typecheck (repo-wide) | gates | S | ~150k tokens, ~10 min | 66 |
| ci (repo-wide) | gates | M | ~600k tokens, ~35 min | 65 |
| ci-pr-minutes (.github/workflows/autofix.yml) | gates | M | ~600k tokens, ~35 min | 65 |
| codeowners-present (repo-wide) | hygiene | S | ~150k tokens, ~10 min | 65 |
| deps-automation (repo-wide) | hygiene | S | ~150k tokens, ~10 min | 65 |
| env-example (repo-wide) | hygiene | S | ~150k tokens, ~10 min | 65 |
| error-tracking (repo-wide) | hygiene | L | ~2000k tokens, ~120 min | 65 |
| gate-composite (repo-wide) | gates | S | ~150k tokens, ~10 min | 65 |
| prop-build-output (build/declaration-emit.test.ts) | proportion | S | ~150k tokens, ~10 min | 65 |
| prop-duplicate-files (src/adapter/deno/deno.d.ts) | proportion | M | ~600k tokens, ~35 min | 65 |
| secret-scan-present (.github/workflows/autofix.yml) | hygiene | S | ~150k tokens, ~10 min | 65 |
| security-policy-present (repo-wide) | hygiene | S | ~150k tokens, ~10 min | 65 |

## Not covered

- merge-frequency (repo-wide)
- change-rework (repo-wide)
- pr-size (repo-wide)
- bus-factor (top)
- agent-share (repo-wide)

## 30/60/90

- 30 days: hygiene gates hygiene hygiene hygiene gates proportion hygiene hygiene
- 60 days: gates gates proportion
- 90 days: hygiene

## First fix

Would dispatch one build for agent-context with pack hygiene. Nothing was dispatched.
