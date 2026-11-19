# f-firstrun report

## Demo commands
    git clone --depth 1 https://github.com/honojs/hono && cd hono
    factory first-run --dry-run     # exit 0, 0.7s: score 65 -> 67, top 3 risks, fix table, first fix
    factory first-run --dry-run     # in fastapi/fastapi: score 68 -> 83
    PATH=/usr/bin factory first-run --dry-run   # exit 2: "factory: auditor not found on PATH; install it with: cargo install --git https://github.com/KaaS-team/auditor"
Reports: docs/demo/first-run-hono.md, docs/demo/first-run-fastapi.md.

## Acceptance
- Exit 0 on both, top 3 risks, table, first fix: done. Caveat: the auditor gives a line only for some findings (fastapi risk 1 has file:line); others show a path or repo-wide.
- Both reports committed with command and date header: done.
- Golden test from recorded auditor JSON (hono): done (TestGoldenHonoReport).
- Missing auditor: one line naming install command, exit 2: done.

## Fixes
Top risks were empty when the auditor names no risk area (hono); now filled from open findings. Locations fall back to evidence paths.

## Upstreams copied
None. Read KaaS-team/auditor README and JSON output.

## Files outside my area
cmd/factory/main.go (exit code via ExitCode() interface, 5 lines). Needs ErrNoAuditor in internal/firstrun.
## Workflow changes needed
None. Note: AGENTS.md says a hook refuses writes under .factory/.
