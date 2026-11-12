# CLI reference

Generated from the command tree. Do not edit by hand.

## factory

`factory`

Plan work into tickets and run them on parallel coding-agent sessions

## factory a2a

`factory a2a [flags]`

Serve the factory as an A2A agent

| Flag | Type | Default | Description |
|---|---|---|---|
| `--addr` | string | `127.0.0.1:8787` | listen address |
| `--audit-log` | string | `a2a-audit.jsonl` | file that gets one JSON line per call |
| `--signing-key` | string | `` | ECDSA P-256 PEM key that signs the agent card (a new key per start when empty) |

## factory add

`factory add <repo>#<path>[@ref] [flags]`

Pin a file from a GitHub repository (MIT or Apache-2.0 only) in factory.lock

| Flag | Type | Default | Description |
|---|---|---|---|
| `--kind` | string | `` | skill, agent, workflow or check (default: from the path) |
| `--root` | string | `.` | repository root holding factory.lock and .factory/cache |

## factory board

`factory board`

Open the terminal board

## factory browsercheck

`factory browsercheck [flags]`

Run browser steps in headless Chrome and print one FACTORY_GATES line

| Flag | Type | Default | Description |
|---|---|---|---|
| `--out` | string | `.factory/browser-out` | directory for screenshots |
| `--profile` | string | `` | Chrome user-data-dir whose Default profile is copied, without caches, for the run |
| `--secrets` | string | `` | YAML file of secrets for type_secret steps; values are never printed |
| `--steps` | string | `.factory/browser-steps.yaml` | YAML file of browser steps |

## factory cancel

`factory cancel <ticket>`

Cancel a ticket's running session

## factory config

`factory config`

Read resolved configuration

## factory config explain

`factory config explain <key>`

Print which layer set a key and which layers it overrode

## factory config get

`factory config get <key>`

Print the resolved value of a key

## factory dashboard

`factory dashboard [flags]`

Serve the read-only web view

| Flag | Type | Default | Description |
|---|---|---|---|
| `--addr` | string | `127.0.0.1:8787` | listen address (loopback by default) |
| `--operator` | bool | `false` | show usage and budget numbers |

## factory dispatch

`factory dispatch <ticket>`

Start a session for a ticket now

## factory doctor

`factory doctor`

Check the tools and settings the factory needs

## factory eval

`factory eval [flags]`

Run the fixtures matrix and write a scorecard

| Flag | Type | Default | Description |
|---|---|---|---|
| `--agent` | string | `` | agent preset name, never a model name (required) |
| `--fixtures` | string | `evals/fixtures` | directory of fixtures |
| `--out` | string | `evals` | directory the scorecard is written to |
| `--packs` | string | `` | packs lock file the run used, e.g. factory.lock |
| `--workflow` | string | `` | workflow name (required) |

## factory eval check

`factory eval check [flags]`

Lint the fixtures; exit 1 when one is malformed

| Flag | Type | Default | Description |
|---|---|---|---|
| `--fix` | bool | `false` | write back the data the tree determines |
| `--fixtures` | string | `evals/fixtures` | directory of fixtures |

## factory eval diff

`factory eval diff <old.json> <new.json>`

Compare two scorecards; exit 1 when the new one is worse

## factory eval replay

`factory eval replay <run.trace.jsonl>`

Print the spans a run recorded, gate spans with their triggered flag

## factory first-run

`factory first-run [flags]`

Audit this repo and show what the factory would fix, at no cost

| Flag | Type | Default | Description |
|---|---|---|---|
| `--annotations` | string | `.factory/annotations.yml` | reason-tagged suppressions file; the default is optional |
| `--dry-run` | bool | `false` | stop after the report; say what would be dispatched |
| `--gh` | string | `` | also audit this GitHub repo (owner/repo) |
| `--sarif` | string | `` | also write the findings to this file as SARIF 2.1.0 |

## factory init

`factory init [flags]`

Write .factory/factory.yaml from a tier preset

| Flag | Type | Default | Description |
|---|---|---|---|
| `--accessible` | bool | `false` | plain numbered prompts instead of the full-screen form |
| `--dir` | string | `.` | repo root to write into |
| `--dispatcher` | string | `` | dispatcher: local, routines, fire; default from the tier |
| `--force` | bool | `false` | overwrite an existing .factory/factory.yaml |
| `--repo` | string | `` | owner/name; default from the origin remote |
| `--tier` | string | `` | tier preset: solo, startup, scaleup, enterprise, regulated, oss |
| `--tracker` | string | `` | tracker: github, linear, jira |
| `--yes` | bool | `false` | run without prompts; needs --tier and --tracker |

## factory logs

`factory logs <ticket> [flags]`

Print what a ticket's session is doing

| Flag | Type | Default | Description |
|---|---|---|---|
| `-f, --follow` | bool | `false` | keep polling until the session ends |
| `--interval` | duration | `5s` | poll interval for --follow |
| `--json` | bool | `false` | print one JSON event per line |

## factory mcp

`factory mcp`

Serve the factory to Claude Code over stdio (MCP)

## factory packs

`factory packs`

Inspect the packs pinned in factory.lock

## factory packs list

`factory packs list [flags]`

Print each lock entry

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | bool | `false` | print JSON |
| `--root` | string | `.` | repository root holding factory.lock and .factory/cache |

## factory packs match

`factory packs match <dir> [flags]`

List the skill packs whose paths or keywords match

| Flag | Type | Default | Description |
|---|---|---|---|
| `--path` | stringSlice | `[]` | a file the task touches (repeatable) |
| `--text` | string | `` | the task text |

## factory packs migrate

`factory packs migrate <owner/repo#path> [flags]`

Run a migration pack pinned in factory.lock over the repository

| Flag | Type | Default | Description |
|---|---|---|---|
| `--root` | string | `.` | repository root holding factory.lock and .factory/cache |

## factory packs run

`factory packs run <pack.yaml> -- <command> [args] [flags]`

Run a command and retry it while the manifest's success checks fail

| Flag | Type | Default | Description |
|---|---|---|---|
| `--root` | string | `.` | repository root holding factory.lock and .factory/cache |
| `--unlocked` | bool | `false` | run a pack that is not pinned in factory.lock (local authoring only) |

## factory packs upgrade

`factory packs upgrade [flags]`

Bump pinned packs to their newest upstream when the eval says it is not worse

| Flag | Type | Default | Description |
|---|---|---|---|
| `--baseline` | string | `` | scorecard JSON of the pinned version |
| `--cache` | string | `` | directory for cached bare repositories (default: factory-packs under the system temp dir) |
| `--candidate` | string | `` | scorecard JSON of the new version |
| `--dir` | string | `.` | directory holding factory.lock |
| `--dry-run` | bool | `false` | report what would change and write nothing |
| `--remote` | string | `https://github.com` | base URL packs are cloned from |
| `--tolerance` | float64 | `0.05` | largest allowed rise in tokens per merged PR, as a fraction |

## factory packs verify

`factory packs verify [flags]`

Re-hash the cache against factory.lock

| Flag | Type | Default | Description |
|---|---|---|---|
| `--root` | string | `.` | repository root holding factory.lock and .factory/cache |

## factory plan

`factory plan [goal] [flags]`

Turn a goal, epic or spec into a ticket DAG; --approve files it

| Flag | Type | Default | Description |
|---|---|---|---|
| `--approve` | bool | `false` | file the tickets; without it nothing is written |
| `--epic` | int | `0` | read the spec and tickets from epic issue `n` |
| `--json` | bool | `false` | print the DAG as JSON |
| `--spec` | string | `` | read the spec and tickets from `file` |

## factory queue

`factory queue`

Show tickets ready to run and the merge queue

## factory repomap

`factory repomap [flags]`

Print a ranked, token-budgeted symbol map of the repository for a context pack

| Flag | Type | Default | Description |
|---|---|---|---|
| `--budget` | int | `1024` | token budget of the map |
| `--root` | string | `.` | repository root |
| `--ticket` | string | `` | ticket text; files and identifiers it names seed the ranking |

## factory report

`factory report [flags]`

Show tokens per merged PR, rework, human touches and cycle time (operator only)

| Flag | Type | Default | Description |
|---|---|---|---|
| `--by` | string | `team` | group rows by team, workflow or pack |
| `--json` | bool | `false` | write JSON instead of markdown |
| `--out` | string | `` | write the report to this file; never under .github/ or a PR body file |
| `--since` | string | `7d` | window length ending now, such as 7d or 36h |

## factory retry

`factory retry <ticket>`

Queue a new attempt for a ticket

## factory run

`factory run [flags]`

Run the factory; --headless streams one JSON event per line

| Flag | Type | Default | Description |
|---|---|---|---|
| `--headless` | bool | `false` | print one api.Event JSON object per line and nothing else on stdout |
| `--slots` | int | `0` | number of parallel slots (overrides config) |

## factory serve

`factory serve [flags]`

Run the factory loop as a service with /healthz, /readyz and /events

| Flag | Type | Default | Description |
|---|---|---|---|
| `--addr` | string | `127.0.0.1:8787` | address for /healthz, /readyz and /events |
| `--drain` | duration | `30s` | how long to wait for the tick in flight on SIGTERM |

## factory shadow

`factory shadow [flags]`

Summarize what shadow mode would have dispatched

| Flag | Type | Default | Description |
|---|---|---|---|
| `--file` | string | `.factory/shadow.ndjson` | shadow log to read |

## factory status

`factory status [flags]`

Show the board, one row per slot

| Flag | Type | Default | Description |
|---|---|---|---|
| `--json` | bool | `false` | print the board as one JSON object |

## factory steer

`factory steer <ticket> [message...]`

Send a message to a ticket's running session

## factory upgrade

`factory upgrade [flags]`

Replace this binary with the latest factory release

| Flag | Type | Default | Description |
|---|---|---|---|
| `--check` | bool | `false` | report whether a newer release exists and change nothing |

## factory version

`factory version`

Print the factory version
