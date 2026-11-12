# Config reference

Generated from `internal/config`. Do not edit by hand.

Layers, lowest to highest precedence: builtin, org, team, repo, env, flags.
Each key is a path in `.factory/factory.yaml`, the flag `--<key>`, and the variable `FACTORY_<KEY>` with dots as underscores.
Keys under `models.` are open: any tier name takes a string.

| Key | Type | Default | Layer rule |
|---|---|---|---|
| `repo` | string | `""` | any layer may set it |
| `tracker` | string | `"github"` | any layer may set it |
| `approval` | string | `"risk"` | any layer may set it |
| `dispatcher` | string | `"claude-cloud"` | any layer may set it |
| `slots` | int | `6` | org value is a cap; lower layers may lower it, never raise it |
| `workflow` | string | `"feature-to-pr"` | any layer may set it |
| `agents` | list | `[claude]` | org value is an allow-list; lower layers may only remove entries |
| `packs` | list | `[]` | org value is an allow-list; lower layers may only remove entries |
| `budgets.node` | number | `5` | org value is a cap; lower layers may lower it, never raise it |
| `budgets.ticket` | number | `12` | org value is a cap; lower layers may lower it, never raise it |
| `budgets.team_day` | number | `100` | org value is a cap; lower layers may lower it, never raise it |
| `budgets.month` | number | `0` | org value is a cap; lower layers may lower it, never raise it |
| `merge_mode` | string | `"queue"` | any layer may set it |
| `batch_size` | int | `1` | org value is a cap; lower layers may lower it, never raise it |
| `stall_after` | duration | `20m0s` | any layer may set it |
| `models_allowed` | list | `[]` | org value is an allow-list; lower layers may only remove entries |
| `base` | string | `"main"` | any layer may set it |
| `poll_interval` | duration | `15s` | any layer may set it |
| `stage_timeout` | duration | `15m0s` | any layer may set it |
| `max_retries` | int | `3` | org value is a cap; lower layers may lower it, never raise it |
| `max_open_prs` | int | `3` | org value is a cap; lower layers may lower it, never raise it |
| `gates` | list | `[]` | any layer may set it |
| `protected_paths` | list | `[]` | any layer may set it |
| `risk_max` | risk | `"high"` | lower layers may pick a risk at or below the org's |
| `auto_merge` | bool | `false` | when the org sets false, lower layers cannot set true |
| `auto_merge_max_risk` | risk | `"low"` | lower layers may pick a risk at or below the org's |
| `requester_cannot_approve` | bool | `true` | when the org sets true, lower layers cannot set false |
