BRANCH: cluster/v6.5-cursor-argv
HEAD: 5e0e63ad89c07867ff2652df8f9402e5f82beb1f
## Summary
#628 is blocked: the real `cursor-agent` binary cannot be installed in this sandbox, so no fixture could be recorded. No code was changed; the branch equals origin/release/v6.5.0.
## Issues
- #628: blocked. Command: `curl -sS -m 20 -o /tmp/cursor-install.sh -w '%{http_code}\n' https://cursor.com/install`. Error: `curl: (56) CONNECT tunnel failed, response 403` (HTTP 000). The agent proxy reports `cursor.com:443 connect_rejected` (host not allowed for this session). `which cursor-agent` finds nothing. Neither acceptance line has a test or mutation file, since both depend on the recorded fixture.
## Staged workflow changes
none
## Checkpoints
#628: no commit made. Checkpoints 1 to 7 hold trivially (empty diff).
## Files outside my area
none
## Gate evidence
not run (no change made)
## Risk and rollback
No risk; nothing changed. Delete the branch to roll back.
## Learnings
- cursor.com is not on the cloud environment's network allowlist, so the installer cannot run. Add `cursor.com` (and the host the installer downloads from) to the environment's allowed hosts, or record the fixture on a machine with the binary.
- Existing cursor fixtures live in tests/fixtures/agents/cursor; a later run can extend them once the binary is reachable.
