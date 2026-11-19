# f-fix-envkeys: runtime FACTORY_* variables no longer break Load

## Demo commands
    FACTORY_MCP_TOKEN=x go test ./internal/config -run RuntimeEnv
    ok  github.com/KaaS-team/factory/internal/config
Before the fix the same input failed with `env layer: unknown key "mcp_token"`.

## Acceptance
- [x] Table test sets each runtime variable (the four named, plus SCIM_TOKEN, SMOKE_REPO, EVAL_RERECORD, POLICY, ROLE, ACTOR) and `Load` succeeds. Done.
- [x] A misspelled key (`FACTORY_SLOTZ`) still fails with `unknown key "slotz"`, even with a runtime variable set. Done.
- [x] Each new test fails with the fix reverted (env filter call replaced by `s.Env`):
  - `runtimeenv_test.go:12: Load with FACTORY_MCP_TOKEN set: env layer: unknown key "mcp_token"`
  - `runtimeenv_test.go:29: runtime variable reported as unknown: env layer: unknown key "mcp_token"`

## Upstreams copied
None.

## Files outside my area
`.ratchet.json`: go_lines baseline raised 42880 to 42892 (+12 non-test lines), with the reason appended.

## Workflow changes needed
None.

## CI note
The `push` job's PR body check rejects a body that links a Claude session. The PR body carries no session link.
