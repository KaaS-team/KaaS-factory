# Jail audit against the Firecracker jailer checklist

The jail is the current binary re-executed as a helper that applies Landlock and rlimits and then
execs the program (`sandbox.go`). It needs no VM, namespaces or root. Each row is checked by
`TestAuditTable`, which reads this file.

| Control | Status | Where |
|---|---|---|
| pid namespace | absent | a jailed process sees every host pid |
| mount namespace | absent | Landlock limits paths; the mount table is the host's |
| net namespace | absent | Landlock denies TCP bind and connect when `AllowNet` is false; UDP and unix sockets are not covered |
| pivot_root | absent | the filesystem root is not changed |
| uid drop | absent | the child runs as the caller's uid |
| cgroup v2 limits | absent | no memory or pids cgroup; only rlimits bound a session |
| rlimits | present | `Spec.Baseline` and `Spec.Exec`, whitelist in `rlimit.go` |
| seccomp | absent | no syscall filter |
| process-group kill | present | `Command` sets `Setpgid` and kills the group on cancel (`procgroup.go`) |
| session id key | absent | the jail has no session id; a caller that wants an audit key must pass one |

## Gaps to file as tickets

1. cgroup v2 memory and pids limits (RLIMIT_AS counts address space, not resident memory, and
   RLIMIT_NPROC counts per uid, so one session can use another's budget).
2. seccomp filter, seeded from the Firecracker musl profile and re-traced for our binaries.
3. pid and mount namespaces through an optional runsc backend.
4. Session id (at most 64 characters of A-Z, a-z, 0-9, dash) as the audit key on `Spec`.

## Bubblewrap flag set (mini-swe-agent `environments/extra/bubblewrap.py`)

We do not use bubblewrap. The upstream flags, and what stands in for each here:

| Upstream flag | Here |
|---|---|
| `--unshare-all` | absent (no namespaces) |
| `--ro-bind / /` | `ReadOnly: ["/"]` through Landlock |
| `--bind <cwd> <cwd>` | `Workdir` is always writable |
| `--tmpfs /tmp` | absent; `/tmp` is the host's and the dispatcher makes it writable |
| `--dev /dev`, `--proc /proc` | absent; host `/dev` and `/proc` are visible |
| `--share-net` | `AllowNet: true` |
| `--die-with-parent` | partial: cancel kills the process group, a parent crash does not |
| `--clearenv` | present: `Spec.Env` is the child's whole environment |
