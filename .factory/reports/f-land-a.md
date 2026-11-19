# f-land-a: first half of the go/* branches

Branch `land/demo-a`, from `origin/next`.

## Demo commands

None. This ticket lands branches; it adds no new surface.
Check it with `./gate.sh` (no `just` on this host). The gate printed no failure.

## Acceptance

- `land/demo-a` passes the gate (`./gate.sh`: fmt, vet, lint, test, test with the ee tag, build, ratchet): done.
- Every branch listed: done, below.

| Branch | Result |
|---|---|
| go/k10-catchup | Merged. The cron scheduler (catch-up of the latest missed tick) is new. It reuses next's `JitterOffset` and `DefaultJitterWindow`; the duplicate copy and its test were removed. `Options.Schedule` joins next's `Jobs` and `Wrap`. |
| go/k3f-meter | Already in next. Content kept as on next. |
| go/k3f-rest | Merged. Kept next's side in `mcp.go`, `main.go`, `cli-reference.md`. |
| go/k3f-surface | Merged in part. Mount and sandbox work was already on next in a newer form. The self-upgrade command (`internal/upgrade/self.go`) is new and replaces `selfupdate.NewCommand`, which I deleted (with its test) so deadcode did not grow. |
| go/k4-core-dispatch | Merged in part. Approve and revise were already on next, newer. Kept next's side. |
| go/k4-docs-truth | Merged cleanly. |
| go/k4-ee-mount | Merged cleanly. |
| go/k4-eval-matrix | Already in next. |
| go/k4-firstrun-pr | Already in next. |
| go/k4-mcp-parity | Already in next. |
| go/k4-mergetree | Already in next. |

Dropped: none.

## Upstreams copied

None new. `THIRD_PARTY_NOTICES.md` keeps both sides (k10-catchup adds a trigger.dev entry).

## Files outside my area

- `.ratchet.json`: go_lines 42207 to 42402, reason line updated (the scheduler and self-upgrade code are real additions).

## Workflow changes needed

None.
