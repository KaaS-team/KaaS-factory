# Runtimes

A runtime is where a gate or a `check` step's shell command runs. Agent steps (triage, plan,
build, verify, pr) still run on the machine that runs the factory.

## Picking one

A repo picks runtimes by name in `.factory/config.json`:

```json
{ "runtime": { "gates": "sandbox", "check": "lwpr" } }
```

A `check` step can name its own with `runtime:` (see [workflows.md](workflows.md)). Unset is `local`.
An unknown name stops `factory watch` at boot. A name that exists in config but not on the machine
running the step fails that issue with a comment saying which name is missing.

## Defining one

`local` (this machine) and `lwpr` (`lwpr run` as it is configured here) always exist. Hosts, images
and tokens belong to the machine, not the repo, so you define every other runtime in
`FACTORY_HOME/machine.json`:

```json
{
  "runtimes": {
    "sandbox": { "kind": "docker", "image": "node:22", "network": "none", "memory": "4g" },
    "gvisor": { "kind": "docker", "image": "node:22", "runtime": "runsc" },
    "box": { "kind": "ssh", "host": "ci1", "dir": "/srv/factory", "exclude": ["node_modules", "dist"] },
    "fc": { "kind": "wrap", "argv": ["firecracker-ctr", "run", "--rm", "--mount", "type=bind,src={cwd},dst={cwd}", "docker.io/library/node:22", "job", "bash", "-c", "{cmd}"] },
    "e2b": { "kind": "http", "url": "https://sandbox.example.com/exec", "tokenEnv": "SANDBOX_TOKEN" },
    "a37": { "kind": "agent37", "instance": "ab12cd34ef", "tokenEnv": "AGENT37_API_KEY" },
    "vm": { "kind": "microsandbox", "image": "node:22-slim", "allow": ["registry.npmjs.org", "api.anthropic.com"], "secrets": ["ANTHROPIC_API_KEY@api.anthropic.com"] }
  }
}
```

| kind | what it does | keys |
|---|---|---|
| `docker` | A throwaway container. The worktree is mounted at its own path, everything else is read-only. It runs with no capabilities, no privilege escalation, capped memory, CPU and pids, and no network unless `network` names one. | `image` (required), `network`, `memory`, `cpus`, `pids`, `runtime` (for example `runsc` for gVisor) |
| `ssh` | rsyncs the worktree to `<dir>/<worktree name>` on the host, then runs the command there. `.git` is never copied. | `host`, `dir` (both required), `exclude` (default `node_modules`) |
| `lwpr` | `lwpr run` packs the worktree and runs the command on the lwpr box. | `app`, `timeoutMin`, `setup` |
| `wrap` | Any launcher: a Firecracker microVM, podman, bubblewrap, nsjail. `{cmd}` must be exactly one element of `argv`, and the bash command goes there. `{cwd}` is the worktree path wherever it appears. | `argv` (required) |
| `http` | A hosted sandbox (e2b, Daytona, Modal or your own) behind the protocol below. | `url` (required; https, or http to loopback only), `tokenEnv`, `exclude` |
| `agent37` | An agent37.com instance, through its exec API (see below). | `instance`, `tokenEnv` (both required), `root` (default `/tmp/factory`), `exclude`, `url` (the exec host) |
| `microsandbox` | A microVM on this machine through `msb` (see below): no network except `allow`, and keys the guest cannot read. | `image` (required), `allow` (hosts, port 443), `secrets` (`ENV@host[,host]`, each host in `allow`), `memory` (default `4G`), `cpus` (default 2) |

`factory doctor` lists the runtimes the repo uses and flags any that are missing.

## A pool of free tiers

A `pool` names `http` and `agent37` runtimes from the same file, in order, each with the monthly minutes its
free tier gives. You copy that figure from the provider's pricing page; the factory holds none.

```json
{
  "runtimes": {
    "e2b": { "kind": "http", "url": "https://e2b-shim.example.com/exec", "tokenEnv": "E2B_SHIM_TOKEN" },
    "daytona": { "kind": "http", "url": "https://daytona-shim.example.com/exec", "tokenEnv": "DAYTONA_SHIM_TOKEN" },
    "free": { "kind": "pool", "members": [{ "runtime": "e2b", "minutes": 60 }, { "runtime": "daytona", "minutes": 30 }] }
  }
}
```

Before a step runs on `free`, the first member with at least `reserveMin` minutes left this month
(default 10, months in UTC) holds everything it has left, in one SQLite transaction in
`FACTORY_HOME/machine.db`. Every watcher on the machine shares that file, so two runs at once hold
minutes apart and together stay inside the allowance. The run is cut off when it reaches the minutes
it holds, and it settles what it used when it ends; a watcher that dies is charged everything it
held. A member that fails as a runtime (unreachable, refused, no answer, an exception) is charged
the minutes it took, keeps the error as its last failure, and the step moves to the next member. A
command that fails on a member is the step's answer.

With every member spent or failed, the step runs on `fallback`: `local` unless the pool names
another runtime. Its stderr starts with a `pool:` line saying why. A pool you chose for isolation
should say `"fallback": "none"`, so the step fails as a runtime instead of running on this machine.
Only `http` and `agent37` members can be cut off mid-run, so a pool takes no other kind.

`factory pool` prints each member's minutes used and left this month and its last failure;
`--json` prints the same as `{ok, data}`.

## The http protocol

```
POST <url>
Authorization: Bearer <value of the env var named by tokenEnv>
{"cmd": "<bash command>", "archive": "<base64 tar.gz of the worktree, without .git and exclude>"}

200 {"stdout": "...", "stderr": "...", "code": 0}
```

The sandbox unpacks the archive, runs `bash -c cmd` inside it, and answers. Each of these fails
the step with an error but never crashes the loop:
- a non-2xx status;
- an answer without the three fields;
- an unreachable URL;
- an unset token variable, which is caught before anything is sent.

The token is read by name when the step runs, so it never appears in `machine.json`, an argv or a
log. `tests/fixtures/http-sandbox.ts` is a reference server for the protocol. A shim in front of a
hosted sandbox does the same work inside the sandbox.

## agent37

Create the instance once (`POST https://api.agent37.com/v1/instances` with `"auto_sleep": true`, so
an idle one bills only its disk) and put its id in `instance`. Each run sends the worktree, without
`.git` and `exclude`, over the exec API itself: an exec body is capped at 128 KB, and the instance's
file API answers only on templates that run an agent. The tar.gz goes in base64 chunks of 96 KB,
is unpacked into a fresh directory under `root`, `bash -c cmd` runs there, and the directory is
removed after. One exec waits at most 15 minutes, so a longer step needs another runtime. A 1 MB
worktree took 12.5 seconds end to end on the default 2 vCPU instance.

## microsandbox

Install `msb` (`brew install superradcompany/tap/microsandbox` on macOS; Linux needs KVM). Each run
boots a fresh microVM from `image` with the worktree mounted at its own path, so its writes land
here. Egress is denied, DNS and port 443 open only for the hosts in `allow`, and with nothing in
`allow` there is no network at all. A secret `ENV@host` is read from this process's env when the VM
starts; inside, `$ENV` is the placeholder `$MSB_ENV`, and msb's proxy swaps in the real value only on
a request to that secret's hosts. The same request to any other host is refused, so a command that
prints the variable or posts it elsewhere leaks nothing. The live test in `tests/runtimes.test.ts`
proves all three against public echo servers; it runs only where `msb` is installed.

### Agents in the VM

`"agentRuntime": "<name>"` in `machine.json` names a `microsandbox` runtime, and every agent stage on
this machine then starts inside it: the worktree and the stage's scratch folder are mounted, the guest
gets only the `FACTORY_*` values and the preset's own settings, and nothing else from this machine's
env. The image must hold the agent CLI and git. Give its key as a secret, for example
`"secrets": ["ANTHROPIC_API_KEY@api.anthropic.com"]` with `api.anthropic.com` in `allow`, so the agent
holds a placeholder it cannot leak. msb 0.7 does not pass piped stdin through, so a prompt sent on
stdin is written to the scratch folder and fed to the agent from there. `FACTORY_SLOTS` overrides
only the slot count and keeps the rest of `machine.json`.

The guest's git is a mirror of the stage repo made for that run, with the blobs of every hidden
path (the holdouts) repacked out, so `git show origin/main:holdout/x` fails inside the VM whatever
agent runs. Its remote leads nowhere, so a push or a fetch fails too, and commits made in the guest
stay there: the runner commits the worktree itself. A protected path changed by any means stops the
run before the push, since the runner diffs the branch, not the agent's tool calls.

### A budget the agent cannot exceed

`"llmGateway": { "url": "https://<host>" }` in `machine.json` sends every agent stage's model calls
through a [LiteLLM](https://docs.litellm.ai) proxy. Before a stage starts, the runner mints a key on
the gateway with `max_budget` set to that stage's `maxBudgetUsd` and a lifetime of the stage timeout
plus five minutes, and revokes it when the stage ends. The gateway refuses a call once the key's spend
reaches its cap, so the cap holds whatever the CLI reports about its own cost. The master key is read
from `FACTORY_LLM_GATEWAY_KEY`, which no agent sees, and the factory refuses to start when the URL is
set and the key is not. The agent gets the gateway as its base URL and the stage key as its only
provider key: `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for `claude`, `OPENAI_BASE_URL` and
`OPENAI_API_KEY` for `codex`, and every other provider credential in the env (OAuth tokens, Bedrock,
Vertex, `AWS_*`, `AZURE_*`) is removed. A stage on any other agent is refused. A failed mint fails the
stage before the agent starts.

On this machine's own shell the cap is only as strong as the agent's manners: a CLI can still read its
login files (`~/.claude`, `~/.codex/auth.json`) and call a provider directly. In the `agentRuntime` VM it
is a hard limit: the stage key is an msb secret toward the gateway host, which must be in `allow`, the
runtime's own provider secrets are dropped, and `machine.json` fails to load when `allow` names a known
model API (`api.anthropic.com`, `api.openai.com`, `openrouter.ai` and the rest of `PROVIDER_DOMAINS`).

## Many workers, one repo

Several factories can drive one repo at once: laptops, a VM, GitHub Actions jobs, or a daemon on
each of them. Two things are shared through GitHub, so it is safe:

- **Leases.** Before a worker walks an issue's steps, it takes `refs/factory/lease/<issue>` on the
  repo's remote. A new lease commit is a child of the current one, so a plain push only lands as a
  fast-forward and two racing workers cannot both win. The holder renews every 10 seconds. Another
  worker takes an expired lease (30 seconds) and leaves a live one alone.
- **Spend.** After each stage, a worker adds its cost to two places:
  - its own marker comment on the issue;
  - its own comment for the day on the `factory:ledger` issue.

  `spend.perIssueUsd` and `spend.dailyUsd` read the sum of every worker's comments. They take the
  larger of that sum and the local SQLite cache, so a GitHub write that failed can't lift a cap.

## In the background

`factory daemon install --repo-dir <path>` runs `factory up` for that repo at login and restarts
it when it exits. On macOS it is a launchd agent in `~/Library/LaunchAgents`; on Linux it is a
systemd user unit. Logs go to `FACTORY_HOME/logs/`. The unit holds only `PATH` and `HOME`, because
`gh` and `claude` read their own credential stores. `factory daemon uninstall` stops the daemon and
removes the file.
