# f-fix-http

## Demo commands
    go test ./cmd/factory -run CrossHost -v
    go test ./internal/mcp -run ForeignHost -v
Both print PASS. With the fix reverted:
    control_redirect_test.go:33: redirect target got Authorization "Bearer SECRET", want none
    mcp_test.go:934: foreign origin: status 200, want 403

## Acceptance
- [x] httptest: a 302 to a second server receives no Authorization header (`TestBearerNotSentOnCrossHostRedirect`).
- [x] httptest: a foreign Host or Origin gets 403 (`TestServeRefusesForeignHostAndOrigin`). Note: the foreign Host case also passes without the guard, because the MCP SDK has its own Host check. The Origin case is the one that fails when the guard is removed.
- [x] Each new test fails with the fix reverted (lines above).

## Changes
- `bearer` now carries the API host (`GITHUB_API_URL` host, else api.github.com) and sets the header only for it. `appAuth` goes through it.
- `mcp.Serve` wraps the handler in `internal/serve/hostguard`, as `serve` does.

## Upstreams copied
None.

## Files outside my area
None.

## Workflow changes needed
None.

## CI note
`prcheck body` refuses any PR body that links a Claude session. The PR tool appends such a footer, so the body was edited to remove it. A re-run reuses the old event body, so the check needs a new push to read the edited one.
