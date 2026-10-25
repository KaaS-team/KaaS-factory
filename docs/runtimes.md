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
    "e2b": { "kind": "http", "url": "https://sandbox.example.com/exec", "tokenEnv": "SANDBOX_TOKEN" }
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

`factory doctor` lists the runtimes the repo uses and flags any that are missing.

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
