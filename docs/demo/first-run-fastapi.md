<!-- Command: factory first-run --dry-run (run in a shallow clone of fastapi/fastapi)
     Date: 2026-11-19 -->

# Factory first-run scorecard

Score now: 68. Projected after the fixes below: 83.

## Top 3 risks

1. Pinned workflow actions (.github/workflows/add-to-project.yml:18)
2. Pull request CI time cap (.github/workflows/add-to-project.yml)
3. Scripts that run (scripts/add_latest_release_date.py)

## What the factory would fix

| Finding | Pack | Size | Estimate | Score after |
|---|---|---|---|---|
| agent-context (repo-wide) | hygiene | S | ~150k tokens, ~10 min | 69 |
| gate-lint (repo-wide) | gates | S | ~150k tokens, ~10 min | 69 |
| gate-test (repo-wide) | gates | S | ~150k tokens, ~10 min | 69 |
| gate-typecheck (repo-wide) | gates | S | ~150k tokens, ~10 min | 69 |
| actions-pinned-sha (.github/workflows/add-to-project.yml:18) | supply | S | ~150k tokens, ~10 min | 69 |
| ci (repo-wide) | gates | M | ~600k tokens, ~35 min | 69 |
| ci-pr-minutes (.github/workflows/add-to-project.yml) | gates | M | ~600k tokens, ~35 min | 69 |
| codeowners-present (repo-wide) | hygiene | S | ~150k tokens, ~10 min | 69 |
| dead-scripts (scripts/add_latest_release_date.py) | gates | M | ~600k tokens, ~35 min | 69 |
| env-example (repo-wide) | hygiene | S | ~150k tokens, ~10 min | 69 |
| gate-composite (repo-wide) | gates | S | ~150k tokens, ~10 min | 69 |
| prop-duplicate-files (tests/test_request_params/test_cookie/test_optional_list.py) | proportion | M | ~600k tokens, ~35 min | 69 |
| resolution-tests (repo-wide) | python | M | ~600k tokens, ~35 min | 69 |
| secret-scan-present (.github/workflows/add-to-project.yml) | hygiene | S | ~150k tokens, ~10 min | 69 |
| security-policy-present (repo-wide) | hygiene | S | ~150k tokens, ~10 min | 69 |

## Not covered

- merge-frequency (repo-wide)
- pr-size (repo-wide)
- bus-factor (top)
- agent-share (repo-wide)

## 30/60/90

- 30 days: hygiene gates gates gates supply hygiene hygiene gates hygiene hygiene
- 60 days: gates gates gates proportion python
- 90 days: nothing

## First fix

Would dispatch one build for actions-pinned-sha with pack supply. Nothing was dispatched.
